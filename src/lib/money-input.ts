/**
 * Money you can type into, with the commas left in.
 *
 * Zarina: "Can you make sure that every amounts have commas?"
 *
 * Every read-only figure in the app already goes through formatCurrency and
 * reads $192,649.74. The editable ones did not, because an input holds a
 * number and a number has no commas, so the Bill this period panel showed
 * 28462.75 in the box directly under $192,649.74 in the total. At six and
 * seven figures that is not cosmetic: 2846275 and 28462.75 look alike at a
 * glance and only one of them is the amount on the pay application.
 *
 * The rules are here rather than in the component so they can be checked
 * without a browser, and so every money box in the app shares one behaviour.
 */

/** Digits, one decimal point, an optional leading minus. Nothing else. */
export function stripMoney(raw: string): string {
  const negative = raw.trim().startsWith("-");
  const cleaned = raw.replace(/[^0-9.]/g, "");
  const firstDot = cleaned.indexOf(".");
  const body =
    firstDot === -1
      ? cleaned
      : cleaned.slice(0, firstDot + 1) + cleaned.slice(firstDot + 1).replace(/\./g, "");
  // A lone minus is a negative being started. Erasing it on the keystroke
  // means a negative can never be typed at all.
  return negative ? `-${body}` : body;
}

function groupInteger(digits: string): string {
  const negative = digits.startsWith("-");
  const body = negative ? digits.slice(1) : digits;
  // Leading zeros are what somebody typed, not a value to normalise mid-word.
  const grouped = body.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return negative ? `-${grouped}` : grouped;
}

/**
 * What the box shows while it is being typed in.
 *
 * Groups the whole-dollar part and leaves the rest alone. A trailing "." is
 * kept, because deleting it the moment it is typed makes the decimal point
 * impossible to enter. Cents are capped at two, since a third digit is never
 * money and silently accepting it means the saved figure disagrees with the
 * one on screen.
 */
export function liveMoneyInput(raw: string): string {
  const cleaned = stripMoney(raw);
  if (cleaned === "" || cleaned === "-") return cleaned;
  const [whole, cents] = cleaned.split(".");
  const grouped = groupInteger(whole);
  if (cents === undefined) return grouped;
  return `${grouped}.${cents.slice(0, 2)}`;
}

/**
 * What the box shows once it is left alone: two decimals, always.
 *
 * The same reasoning as formatCurrency. These figures are copied onto a G702
 * and into the owner's records, and a column that rags on the decimal is
 * harder to check than one that does not.
 */
export function settleMoneyInput(raw: string): string {
  const n = parseMoneyInput(raw);
  if (n === null) return "";
  return liveMoneyInput(n.toFixed(2));
}

/** The number behind the text, or null when there is not one. */
export function parseMoneyInput(raw: string): number | null {
  const cleaned = stripMoney(raw);
  if (cleaned === "" || cleaned === "-" || cleaned === ".") return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/**
 * What a form actually posts.
 *
 * The visible box carries commas; this is what goes in the hidden field beside
 * it, under the real name. Every server action already reads that name and
 * does Number() on it, and "28,462.75" is NaN, so the raw value has to travel
 * separately. Empty stays empty rather than becoming 0, because a blank box
 * and a zero are different answers.
 */
export function moneyFormValue(raw: string): string {
  const n = parseMoneyInput(raw);
  return n === null ? "" : String(n);
}

/** Seed the box from a stored number. */
export function moneyInputFrom(
  value: number | string | null | undefined,
): string {
  if (value === null || value === undefined || value === "") return "";
  const n = typeof value === "number" ? value : parseMoneyInput(String(value));
  if (n === null || !Number.isFinite(n)) return "";
  return liveMoneyInput(n.toFixed(2));
}
