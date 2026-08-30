import * as React from "react"

import { cn } from "@/lib/utils"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { usesHour12 } from "@contracts/clock-format"

interface TimeSelectProps {
  /** 24h `HH:MM` string. Storage is always 24-hour. `24:00` is end of day. */
  value: string
  onChange: (value: string) => void
  disabled?: boolean
  /**
   * Minute grid. `1` is native `<input type="time">` granularity (any minute).
   * Scheduler windows keep `15`. Default stays `15` so existing booking-window
   * editors do not change.
   */
  stepMinutes?: number
  className?: string
  /**
   * Business IANA timezone. Labels follow that zone's clock (24-hour in Europe,
   * AM/PM in the US). The value written back stays `HH:MM`.
   */
  timezone?: string | null
  /**
   * Offer the `24:00` end-of-day sentinel. Must stay false on start pickers;
   * a start of `24:00` is a zero-length window and produces no slots.
   * A stored `24:00` still displays when this is false, but is not offered.
   */
  allowEndOfDay?: boolean
  "aria-label"?: string
}

function pad2(n: number): string {
  return String(n).padStart(2, "0")
}

/**
 * Parse a stored `HH:MM`. `24:00` is the slot-engine end-of-day marker (1440
 * minutes). Any other 24:xx is invalid, matching `parseHHMM` in slot-engine.ts.
 */
export function parseTimeSelectHhmm(value: string): { hour: number; minute: number } | null {
  if (!/^\d{1,2}:\d{2}$/.test(value)) return null
  const [hourStr, minuteStr] = value.split(":")
  const hour = Number(hourStr)
  const minute = Number(minuteStr)
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null
  if (hour < 0 || hour > 24 || minute < 0 || minute > 59) return null
  if (hour === 24 && minute !== 0) return null
  return { hour, minute }
}

function formatHhmm(hour: number, minute: number): string {
  return `${pad2(hour)}:${pad2(minute)}`
}

function hour12Parts(hour24: number): { hour: number; period: "AM" | "PM" } {
  return {
    hour: hour24 % 12 === 0 ? 12 : hour24 % 12,
    period: hour24 < 12 ? "AM" : "PM",
  }
}

function hour24From(hour12: number, period: "AM" | "PM"): number {
  if (period === "AM") return hour12 === 12 ? 0 : hour12
  return hour12 === 12 ? 12 : hour12 + 12
}

/**
 * Hour choices. 12-hour zones stay 1–12. 24-hour zones list `24` only when
 * `allowEndOfDay` is true (end-time fields). Start pickers never get `24`.
 */
export function timeSelectHours(hour12: boolean, allowEndOfDay = false): number[] {
  if (hour12) return Array.from({ length: 12 }, (_, i) => i + 1)
  const hours = Array.from({ length: 24 }, (_, h) => h)
  if (allowEndOfDay) hours.push(24)
  return hours
}

/** Minutes listed in the picker. A stored off-grid minute stays selectable. */
export function timeSelectMinutes(stepMinutes: number, currentHhmm?: string): number[] {
  const step = stepMinutes > 0 ? stepMinutes : 1
  const parsed = currentHhmm ? parseTimeSelectHhmm(currentHhmm) : null
  if (parsed?.hour === 24) return [0]
  const out: number[] = []
  for (let m = 0; m < 60; m += step) out.push(m)
  const extra = parsed?.minute
  if (extra != null && !out.includes(extra)) {
    out.push(extra)
    out.sort((a, b) => a - b)
  }
  return out
}

function named(ariaLabel: string | undefined, part: string): string {
  return ariaLabel ? `${ariaLabel} ${part}` : part
}

function hourItemLabel(hour: number, hour12: boolean): string {
  if (hour === 24) return "24"
  return hour12 ? String(hour) : pad2(hour)
}

const END_OF_DAY_PERIOD = "EOD"
const END_OF_DAY_PERIOD_LABEL = "AM (end of day)"

/**
 * Themed time picker replacing native `<input type="time">`.
 * Native time inputs follow the owner's OS locale, so a US-locale Mac showed
 * AM/PM for a Belgian business. Labels follow the business timezone instead.
 *
 * Hour + minute (and AM/PM when the zone uses a 12-hour clock) so a 1-minute
 * step is usable. Stored `24:00` stays `24:00`. In 12-hour zones it is labeled
 * `12:00 AM (end of day)`, never a raw hour 24 and never converted to `00:00`.
 * Choosing `24:00` is opt-in via `allowEndOfDay` (end-time fields only).
 */
export const TimeSelect: React.FC<TimeSelectProps> = ({
  value,
  onChange,
  disabled,
  stepMinutes = 15,
  className,
  timezone,
  allowEndOfDay = false,
  "aria-label": ariaLabel,
}) => {
  const hour12 = usesHour12(timezone)
  const parsed = parseTimeSelectHhmm(value)
  const endOfDay = parsed?.hour === 24
  const minutes = React.useMemo(
    () => timeSelectMinutes(stepMinutes, value || undefined),
    [stepMinutes, value],
  )
  const hours = React.useMemo(
    () => timeSelectHours(hour12, allowEndOfDay),
    [hour12, allowEndOfDay],
  )

  const commit = (hour: number, minute: number) => {
    if (hour === 24) {
      onChange(allowEndOfDay ? "24:00" : "00:00")
      return
    }
    onChange(formatHhmm(hour, minute))
  }

  const parts12 = endOfDay
    ? { hour: 12, period: "AM" as const }
    : parsed
      ? hour12Parts(parsed.hour)
      : null
  const selectedHour =
    parsed == null ? undefined : hour12 ? parts12!.hour : parsed.hour
  const periodValue = endOfDay ? END_OF_DAY_PERIOD : parts12?.period
  const triggerClass = cn("w-[3.5rem] px-2", className)

  return (
    <div
      role="group"
      aria-label={ariaLabel}
      className="flex items-center gap-1"
    >
      <Select
        value={selectedHour != null ? String(selectedHour) : undefined}
        onValueChange={(next) => {
          const hour = Number(next)
          if (!hour12 && hour === 24) {
            commit(24, 0)
            return
          }
          const minute = endOfDay ? 0 : parsed?.minute ?? 0
          if (hour12) commit(hour24From(hour, parts12?.period ?? "AM"), minute)
          else commit(hour, minute)
        }}
        disabled={disabled}
      >
        <SelectTrigger aria-label={named(ariaLabel, "hours")} className={triggerClass}>
          <SelectValue placeholder="--">
            {selectedHour != null ? hourItemLabel(selectedHour, hour12) : undefined}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          {hours.map((h) => (
            <SelectItem key={h} value={String(h)}>
              {hourItemLabel(h, hour12)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <span className="text-text-muted" aria-hidden>
        :
      </span>
      <Select
        value={parsed ? String(parsed.minute) : undefined}
        onValueChange={(next) => {
          const minute = Number(next)
          if (endOfDay) {
            commit(0, minute)
            return
          }
          commit(parsed?.hour ?? 0, minute)
        }}
        disabled={disabled}
      >
        <SelectTrigger aria-label={named(ariaLabel, "minutes")} className={triggerClass}>
          <SelectValue placeholder="--">
            {parsed ? pad2(parsed.minute) : undefined}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          {minutes.map((m) => (
            <SelectItem key={m} value={String(m)}>
              {pad2(m)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {hour12 && (
        <Select
          value={periodValue}
          onValueChange={(next) => {
            if (next === END_OF_DAY_PERIOD) {
              commit(24, 0)
              return
            }
            const hour12val = parts12?.hour ?? 12
            const minute = endOfDay ? 0 : parsed?.minute ?? 0
            commit(hour24From(hour12val, next as "AM" | "PM"), minute)
          }}
          disabled={disabled}
        >
          <SelectTrigger
            aria-label={named(ariaLabel, "AM/PM")}
            className={cn(
              endOfDay ? "w-[9.75rem] px-2" : "w-[4.25rem] px-2",
              className,
            )}
          >
            <SelectValue placeholder="--">
              {endOfDay ? END_OF_DAY_PERIOD_LABEL : parts12?.period}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="AM">AM</SelectItem>
            <SelectItem value="PM">PM</SelectItem>
            {allowEndOfDay && (
              <SelectItem value={END_OF_DAY_PERIOD}>{END_OF_DAY_PERIOD_LABEL}</SelectItem>
            )}
          </SelectContent>
        </Select>
      )}
    </div>
  )
}
