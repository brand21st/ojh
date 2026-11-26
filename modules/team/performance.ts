import { TEAM_ACTIONS, type TeamAction, type TeamCounts, type TeamPerformance } from "@/types/team";
import type { MemberRole } from "@/types/domain";

const IST_OFFSET_MS = 330 * 60 * 1000;

export function emptyCounts(): TeamCounts {
  return { "order.booked": 0, "order.packed": 0, "label.printed": 0, "manifest.created": 0 };
}

/** YYYY-MM-DD for the India calendar day that contains this instant. */
export function istDay(date: Date) {
  return new Date(date.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/** UTC instant at which an India calendar day (YYYY-MM-DD) starts. */
export function istDayStart(day: string) {
  return new Date(new Date(`${day}T00:00:00.000Z`).getTime() - IST_OFFSET_MS);
}

export function addDays(day: string, days: number) {
  const date = new Date(`${day}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** Inclusive list of India days from..to, capped at 93 days. */
export function dayRange(from: string, to: string) {
  const days: string[] = [];
  let day = from;
  while (day <= to && days.length < 93) {
    days.push(day);
    day = addDays(day, 1);
  }
  return days;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Clean from/to query values into India days. Defaults to the last 7 days, today included. */
export function resolveRange(input: { from?: string | null; to?: string | null }, now = new Date()) {
  const today = istDay(now);
  let to = input.to && DAY.test(input.to) ? input.to : today;
  if (to > today) to = today;
  let from = input.from && DAY.test(input.from) ? input.from : addDays(to, -6);
  if (from > to) from = to;
  const earliest = addDays(to, -92);
  if (from < earliest) from = earliest;
  return { from, to, start: istDayStart(from), end: istDayStart(addDays(to, 1)) };
}

export type SummaryRow = {
  actor_id: string | null;
  day: string;
  action: string;
  events: number | string;
  quantity: number | string;
};

export type PeopleById = Map<
  string,
  { name: string; email: string | null; role: MemberRole | null; team: string | null }
>;

function isAction(value: string): value is TeamAction {
  return (TEAM_ACTIONS as string[]).includes(value);
}

/** Manifests count shipments manifested; everything else counts orders. */
function amount(row: SummaryRow) {
  return Number(row.action === "manifest.created" ? row.quantity : row.events) || 0;
}

export function buildPerformance(
  rows: SummaryRow[],
  people: PeopleById,
  range: { from: string; to: string }
): TeamPerformance {
  const days = dayRange(range.from, range.to);
  const totals = emptyCounts();
  const byActor = new Map<string, { totals: TeamCounts; perDay: Map<string, TeamCounts> }>();

  for (const row of rows) {
    if (!isAction(row.action)) continue;
    const day = String(row.day).slice(0, 10);
    const key = row.actor_id ?? "";
    const value = amount(row);
    totals[row.action] += value;
    let entry = byActor.get(key);
    if (!entry) {
      entry = { totals: emptyCounts(), perDay: new Map() };
      byActor.set(key, entry);
    }
    entry.totals[row.action] += value;
    const dayCounts = entry.perDay.get(day) ?? emptyCounts();
    dayCounts[row.action] += value;
    entry.perDay.set(day, dayCounts);
  }

  // Everyone on the team appears, even with zero work, so a quiet day is visible.
  for (const id of people.keys()) {
    if (!byActor.has(id)) byActor.set(id, { totals: emptyCounts(), perDay: new Map() });
  }

  const members = Array.from(byActor.entries()).map(([key, entry]) => {
    const person = key ? people.get(key) : undefined;
    let bestDay: { day: string; count: number } | null = null;
    for (const [day, counts] of entry.perDay) {
      const count = counts["order.booked"] + counts["order.packed"];
      if (count > 0 && (!bestDay || count > bestDay.count)) bestDay = { day, count };
    }
    return {
      actorId: key || null,
      name: key ? person?.name ?? "Former member" : "Automation",
      email: person?.email ?? null,
      role: person?.role ?? null,
      team: person?.team ?? null,
      totals: entry.totals,
      bestDay,
      activeDays: entry.perDay.size,
    };
  });

  members.sort((a, b) => {
    const left = a.totals["order.booked"] + a.totals["order.packed"] + a.totals["label.printed"];
    const right = b.totals["order.booked"] + b.totals["order.packed"] + b.totals["label.printed"];
    if (right !== left) return right - left;
    if (!a.actorId) return 1;
    if (!b.actorId) return -1;
    return a.name.localeCompare(b.name);
  });

  const daily: TeamPerformance["daily"] = [];
  for (const [key, entry] of byActor) {
    for (const [day, counts] of entry.perDay) {
      daily.push({ day, actorId: key || null, ...counts });
    }
  }
  daily.sort((a, b) => a.day.localeCompare(b.day));

  return { from: range.from, to: range.to, days, totals, members, daily };
}
