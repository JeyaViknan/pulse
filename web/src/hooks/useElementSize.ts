import { useEffect, useRef, useState, type RefObject } from 'react'

export interface ElementSize<T extends Element> {
  ref: RefObject<T | null>
  width: number
  height: number
}

/** Tracks an element's content-box size, so the chart draws at true pixel dimensions. */
export function useElementSize<T extends Element>(): ElementSize<T> {
  const ref = useRef<T | null>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })

  useEffect(() => {
    const element = ref.current
    if (!element) return undefined
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return
      const { width, height } = entry.contentRect
      setSize((previous) => (previous.width === width && previous.height === height ? previous : { width, height }))
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  return { ref, ...size }
}
