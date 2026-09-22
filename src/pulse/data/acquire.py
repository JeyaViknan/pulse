"""Stage 1 — acquire the Corpus A text columns (SPEC §7.1).

Reads only the admitted columns from the dataset's Parquet export. For each remote shard:

1. the Parquet footer is fetched with a range request and parsed;
2. the byte ranges of the admitted column chunks are computed from it;
3. exactly those ranges are fetched, in parallel, into a local sparse copy of the shard at
   their original offsets;
4. the local copy is decoded with ``pyarrow`` reading only the admitted columns.

The 3,072 ``embedding_*`` columns, ``probability_trajectory``, ``customer_engagement``,
``sales_effectiveness`` and ``full_text`` are never requested. Every range request is retried,
and a shard already acquired is skipped, so an interrupted run resumes where it stopped.
"""

from __future__ import annotations

import argparse
import os
import struct
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from pathlib import Path

import httpx
import pyarrow as pa
import pyarrow.parquet as pq

from pulse.paths import INTERIM_DIR

REPO_ID = "DeepMostInnovations/saas-sales-conversations"
PARQUET_BASE = f"https://huggingface.co/datasets/{REPO_ID}/resolve/refs%2Fconvert%2Fparquet/default/train"
SHARD_NAMES = tuple(f"{index:04d}.parquet" for index in range(5))
EXPECTED_ROWS = 100_000

#: The only columns the project reads. ``conversation_length`` is for stratification and EDA only.
ADMITTED_COLUMNS = ("conversation_id", "company_id", "conversation", "outcome", "conversation_length")

#: Columns that must never be read (SPEC §7.1).
FORBIDDEN_COLUMNS = (
    "probability_trajectory",
    "customer_engagement",
    "sales_effectiveness",
    "full_text",
)

assert not set(ADMITTED_COLUMNS) & set(FORBIDDEN_COLUMNS)
assert not any(column.startswith("embedding_") for column in ADMITTED_COLUMNS)

SCHEMA = pa.schema(
    [
        ("conversation_id", pa.string()),
        ("company_id", pa.string()),
        ("conversation", pa.string()),
        ("outcome", pa.int64()),
        ("conversation_length", pa.int64()),
    ]
)

OUTPUT_PATH = INTERIM_DIR / "corpus_a.parquet"
SHARD_DIR = INTERIM_DIR / "corpus_a_shards"

#: Throughput is limited per connection, so ranges are fetched in parallel in small pieces.
CONNECTIONS = 16
PIECE_BYTES = 2 * 1024 * 1024
ATTEMPTS = 12


@dataclass(frozen=True)
class ByteRange:
    start: int
    length: int


class RangeReader:
    """Fetches byte ranges of one remote file, refreshing the signed CDN location as needed."""

    def __init__(self, url: str) -> None:
        self.url = url
        self._client = httpx.Client(follow_redirects=True, timeout=httpx.Timeout(30.0, read=60.0))
        self._lock = threading.Lock()
        self._location: str | None = None
        self.size = self._resolve()

    def _resolve(self) -> int:
        for attempt in range(1, ATTEMPTS + 1):
            try:
                response = self._client.get(self.url, headers={"Range": "bytes=0-3"})
                response.raise_for_status()
                with self._lock:
                    self._location = str(response.url)
                return int(response.headers["Content-Range"].rsplit("/", 1)[1])
            except (httpx.HTTPError, KeyError, ValueError) as error:
                if attempt == ATTEMPTS:
                    raise
                time.sleep(min(20.0, 2.0 * attempt))
                print(f"  resolve: {type(error).__name__}; retry {attempt}", flush=True)
        raise AssertionError("unreachable")

    def read(self, start: int, length: int) -> bytes:
        end = start + length - 1
        for attempt in range(1, ATTEMPTS + 1):
            with self._lock:
                location = self._location or self.url
            try:
                response = self._client.get(location, headers={"Range": f"bytes={start}-{end}"})
                if response.status_code in (401, 403):  # signed location expired
                    self._resolve()
                    continue
                response.raise_for_status()
                data = response.content
                if len(data) != length:
                    raise ValueError(f"short read: {len(data)} of {length} bytes")
                return data
            except (httpx.HTTPError, ValueError) as error:
                if attempt == ATTEMPTS:
                    raise
                time.sleep(min(20.0, 1.5 * attempt))
                if attempt % 4 == 0:
                    print(f"  range {start}+{length}: {type(error).__name__}; retry {attempt}", flush=True)
        raise AssertionError("unreachable")

    def close(self) -> None:
        self._client.close()


def admitted_ranges(metadata: pq.FileMetaData) -> list[ByteRange]:
    names = [metadata.schema.column(index).name for index in range(metadata.num_columns)]
    wanted = [names.index(column) for column in ADMITTED_COLUMNS]
    ranges: list[ByteRange] = []
    for group in range(metadata.num_row_groups):
        row_group = metadata.row_group(group)
        for column in wanted:
            chunk = row_group.column(column)
            start = chunk.data_page_offset
            if chunk.has_dictionary_page and chunk.dictionary_page_offset is not None:
                start = min(start, chunk.dictionary_page_offset)
            ranges.append(ByteRange(start, chunk.total_compressed_size))
    return ranges


def split_pieces(ranges: list[ByteRange]) -> list[ByteRange]:
    pieces: list[ByteRange] = []
    for byte_range in ranges:
        offset = 0
        while offset < byte_range.length:
            length = min(PIECE_BYTES, byte_range.length - offset)
            pieces.append(ByteRange(byte_range.start + offset, length))
            offset += length
    return pieces


def acquire_shard(name: str, destination: Path) -> int:
    reader = RangeReader(f"{PARQUET_BASE}/{name}")
    sparse = destination.with_suffix(".sparse")
    try:
        # 1 — footer: the last 8 bytes hold its length and the PAR1 magic.
        tail = reader.read(reader.size - 8, 8)
        footer_length = struct.unpack("<I", tail[:4])[0]
        if tail[4:] != b"PAR1":
            raise RuntimeError(f"{name} is not a Parquet file")
        footer_start = reader.size - 8 - footer_length
        footer = reader.read(footer_start, footer_length)

        with open(sparse, "wb") as handle:
            handle.truncate(reader.size)
        descriptor = os.open(sparse, os.O_WRONLY)
        try:
            os.pwrite(descriptor, b"PAR1", 0)
            os.pwrite(descriptor, footer + tail, footer_start)
        finally:
            os.close(descriptor)

        metadata = pq.read_metadata(sparse)
        missing = set(ADMITTED_COLUMNS) - set(metadata.schema.names)
        if missing:
            raise RuntimeError(f"{name} is missing columns: {sorted(missing)}")

        # 2–3 — admitted column chunks only, fetched in parallel into their original offsets.
        pieces = split_pieces(admitted_ranges(metadata))
        wanted_bytes = sum(piece.length for piece in pieces)
        print(
            f"{name}: {metadata.num_row_groups} row groups, fetching {wanted_bytes / 1e6:.1f} MB "
            f"of {reader.size / 1e6:.1f} MB ({len(pieces)} ranges)",
            flush=True,
        )
        descriptor = os.open(sparse, os.O_WRONLY)
        started = time.perf_counter()
        done_bytes = 0
        try:
            with ThreadPoolExecutor(max_workers=CONNECTIONS) as pool:
                futures = {pool.submit(reader.read, piece.start, piece.length): piece for piece in pieces}
                for count, future in enumerate(as_completed(futures), start=1):
                    piece = futures[future]
                    os.pwrite(descriptor, future.result(), piece.start)
                    done_bytes += piece.length
                    if count % 25 == 0 or count == len(pieces):
                        elapsed = time.perf_counter() - started
                        print(
                            f"  {done_bytes / 1e6:6.1f}/{wanted_bytes / 1e6:.1f} MB "
                            f"({done_bytes / 1e6 / max(elapsed, 1e-6):.2f} MB/s)",
                            flush=True,
                        )
        finally:
            os.close(descriptor)

        # 4 — decode the admitted columns locally.
        rows = 0
        partial = destination.with_suffix(".partial")
        parquet = pq.ParquetFile(sparse)
        with pq.ParquetWriter(partial, SCHEMA, compression="zstd") as writer:
            for group in range(parquet.num_row_groups):
                table = parquet.read_row_group(group, columns=list(ADMITTED_COLUMNS))
                writer.write_table(table.select(list(ADMITTED_COLUMNS)).cast(SCHEMA))
                rows += table.num_rows
        partial.replace(destination)
        return rows
    finally:
        reader.close()
        sparse.unlink(missing_ok=True)


def acquire(output: Path = OUTPUT_PATH) -> int:
    SHARD_DIR.mkdir(parents=True, exist_ok=True)
    started = time.perf_counter()
    local: list[Path] = []
    for index, name in enumerate(SHARD_NAMES):
        destination = SHARD_DIR / name
        if destination.exists():
            print(f"shard {index + 1}/{len(SHARD_NAMES)}: already acquired", flush=True)
        else:
            rows = acquire_shard(name, destination)
            print(
                f"shard {index + 1}/{len(SHARD_NAMES)}: {rows:,} rows ({time.perf_counter() - started:.0f}s)",
                flush=True,
            )
        local.append(destination)

    total = 0
    partial = output.with_suffix(".partial")
    with pq.ParquetWriter(partial, SCHEMA, compression="zstd") as writer:
        for path in local:
            parquet = pq.ParquetFile(path)
            for group in range(parquet.num_row_groups):
                table = parquet.read_row_group(group)
                writer.write_table(table)
                total += table.num_rows

    if total != EXPECTED_ROWS:
        raise RuntimeError(f"Gate failed: expected {EXPECTED_ROWS:,} rows, read {total:,}.")
    partial.replace(output)
    print(f"Gate passed: wrote {total:,} rows to {output}")
    return total


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=OUTPUT_PATH)
    args = parser.parse_args()
    acquire(args.output)


if __name__ == "__main__":
    main()
