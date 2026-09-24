"use client";

import * as React from "react";

import { cn } from "@/lib/utils";
import {
  liveMoneyInput,
  moneyFormValue,
  moneyInputFrom,
  parseMoneyInput,
  settleMoneyInput,
} from "@/lib/money-input";

/**
 * A money box that keeps its commas.
 *
 * Zarina: "Can you make sure that every amounts have commas?" Read-only
 * figures all go through formatCurrency; the editable ones held a bare number,
 * so 28462.75 sat in the box directly under $192,649.74 in the total.
 *
 * Two things make this safe to drop in anywhere:
 *
 * The visible box is text, never a number input, because a number input will
 * not hold a comma at all. Typing groups as you go and leaves a half-typed
 * decimal alone; leaving the box settles it to two places.
 *
 * When it carries a `name` it posts through a hidden field holding the raw
 * number. Every server action already reads that name and calls Number() on
 * it, and Number("28,462.75") is NaN, so the commas must not reach the form.
 * Nothing on the server side has to change.
 */
export type MoneyInputProps = Omit<
  React.InputHTMLAttributes<HTMLInputElement>,
  "value" | "defaultValue" | "onChange" | "type"
> & {
  /** Posts the raw number under this name, through a hidden field. */
  name?: string;
  /** Uncontrolled starting value. */
  defaultValue?: number | string | null;
  /** Controlled value. Pass with onValueChange. */
  value?: number | string | null;
  /** Fires with the parsed number, or null when the box is empty. */
  onValueChange?: (value: number | null) => void;
  /**
   * Fires with the raw numeric text, commas stripped, for the call sites that
   * hold their amount as a string and call Number() on it later. They get back
   * exactly what they held before while the box on screen keeps its commas.
   */
  onTextChange?: (raw: string) => void;
  /**
   * Skip the standard field styling and take className alone. For the compact
   * grids that style their own inputs, where the full-height default would
   * stand a row taller than its neighbours.
   */
  bare?: boolean;
};

export const MoneyInput = React.forwardRef<HTMLInputElement, MoneyInputProps>(
  (
    {
      className,
      name,
      defaultValue,
      value,
      onValueChange,
      onTextChange,
      onBlur,
      bare,
      ...props
    },
    ref,
  ) => {
    const controlled = value !== undefined;
    const [text, setText] = React.useState(() =>
      moneyInputFrom(controlled ? value : defaultValue),
    );
    // While the box has focus the text is whatever is being typed, commas and
    // all. Re-seeding from the prop mid-keystroke would fight the caret.
    const [typing, setTyping] = React.useState(false);
    React.useEffect(() => {
      if (controlled && !typing) setText(moneyInputFrom(value));
    }, [controlled, value, typing]);

    const shown = text;

    return (
      <>
        <input
          {...props}
          ref={ref}
          type="text"
          inputMode="decimal"
          autoComplete="off"
          value={shown}
          onFocus={(e) => {
            setTyping(true);
            props.onFocus?.(e);
          }}
          onChange={(e) => {
            const next = liveMoneyInput(e.target.value);
            setText(next);
            onValueChange?.(parseMoneyInput(next));
            onTextChange?.(moneyFormValue(next));
          }}
          onBlur={(e) => {
            setTyping(false);
            const settled = settleMoneyInput(e.target.value);
            setText(settled);
            onValueChange?.(parseMoneyInput(settled));
            onTextChange?.(moneyFormValue(settled));
            onBlur?.(e);
          }}
          className={cn(
            bare
              ? ""
              : "flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50",
            className,
          )}
        />
        {name && <input type="hidden" name={name} value={moneyFormValue(shown)} />}
      </>
    );
  },
);
MoneyInput.displayName = "MoneyInput";
