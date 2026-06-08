import * as React from "react"

import { cn } from "@/lib/utils"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

interface TimeSelectProps {
  /** 24h `HH:MM` string. */
  value: string
  onChange: (value: string) => void
  disabled?: boolean
  /** Spacing between options, in minutes. */
  stepMinutes?: number
  className?: string
}

/** Build `HH:MM` options across the day, injecting `extra` if off-grid. */
function buildTimes(step: number, extra?: string): string[] {
  const out: string[] = []
  for (let m = 0; m < 24 * 60; m += step) {
    const h = String(Math.floor(m / 60)).padStart(2, "0")
    const min = String(m % 60).padStart(2, "0")
    out.push(`${h}:${min}`)
  }
  if (extra && !out.includes(extra)) {
    out.push(extra)
    out.sort()
  }
  return out
}

/**
 * Themed time picker (shadcn Select) replacing native `<input type="time">`.
 * Lists times on a fixed grid; an existing off-grid value is preserved.
 */
export const TimeSelect: React.FC<TimeSelectProps> = ({
  value,
  onChange,
  disabled,
  stepMinutes = 15,
  className,
}) => {
  const times = React.useMemo(
    () => buildTimes(stepMinutes, value || undefined),
    [stepMinutes, value]
  )

  return (
    <Select value={value || undefined} onValueChange={onChange} disabled={disabled}>
      <SelectTrigger className={cn("w-28", className)}>
        <SelectValue placeholder="--:--" />
      </SelectTrigger>
      <SelectContent>
        {times.map((t) => (
          <SelectItem key={t} value={t}>
            {t}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
