"""Text utilities shared by training and serving, so both see identical inputs."""

from __future__ import annotations

import re

_WORD = re.compile(r"[A-Za-z0-9$%'’]+")

_WH_WORDS = r"(?:what|what's|whats|when|where|which|who|whom|whose|why|how|how's|hows)"
_AUXILIARIES = (
    r"(?:is|are|am|was|were|do|does|did|can|could|will|would|should|shall|may|might|must|"
    r"have|has|had|isn't|aren't|don't|doesn't|didn't|can't|couldn't|won't|wouldn't|shouldn't|"
    r"haven't|hasn't)"
)
_SUBJECTS = r"(?:i|you|we|they|he|she|it|this|that|there|these|those|your|our|the|any|anyone|anybody|someone)"

#: A clause opens with a wh-word, or with an auxiliary followed by a subject (inversion).
_QUESTION_CLAUSE = re.compile(
    rf"(?:^|[.!?,;:\-—–…]\s*|\b(?:and|but|so|or|also|okay|ok|well|like|um|uh|hmm)\s+)"
    rf"(?:{_WH_WORDS}\b|{_AUXILIARIES}\s+{_SUBJECTS}\b)",
    re.IGNORECASE,
)
#: Tag questions and explicit requests for an answer.
_QUESTION_TAG = re.compile(
    r"\b(?:right|correct|isn't it|aren't they|don't you|wouldn't you|any thoughts|you know what i mean)\s*$",
    re.IGNORECASE,
)


def word_count(text: str) -> int:
    """Token count used for F4/F5: words and numbers, ignoring punctuation and emoji."""
    return len(_WORD.findall(text))


def is_interrogative(text: str) -> bool:
    """F6: lexical question detection — wh-words and auxiliary inversion, never ``?``.

    Terminal punctuation is deliberately ignored: ASR punctuation is unreliable, and a feature
    that depends on it would behave differently live than in training (report §5, C5).
    """
    # "?" becomes an ordinary clause boundary: it may separate clauses but never signals a question.
    stripped = text.replace("?", ".").strip()
    return bool(_QUESTION_CLAUSE.search(stripped) or _QUESTION_TAG.search(stripped))
