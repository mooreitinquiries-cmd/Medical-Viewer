import * as React from "react";

import { cn } from "@/lib/utils";

type SliderProps = Omit<React.HTMLAttributes<HTMLSpanElement>, "onChange"> & {
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
  value?: number[];
  defaultValue?: number[];
  minStepsBetweenThumbs?: number;
  onValueChange?: (value: number[]) => void;
  onValueCommit?: (value: number[]) => void;
};

const DEFAULT_THUMB_LABELS = ["Trim start", "Trim end"];

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function roundToStep(value: number, step: number, min: number) {
  if (step <= 0) return value;
  const steps = Math.round((value - min) / step);
  const precision = Math.max(0, (step.toString().split(".")[1] || "").length);
  return Number((min + steps * step).toFixed(precision));
}

function normalizeValues(values: number[], min: number, max: number, step: number) {
  return values
    .map((value) => roundToStep(clamp(value, min, max), step, min))
    .sort((a, b) => a - b);
}

const Slider = React.forwardRef<HTMLSpanElement, SliderProps>(
  (
    {
      className,
      min = 0,
      max = 100,
      step = 1,
      disabled = false,
      value,
      defaultValue,
      minStepsBetweenThumbs = 0,
      onValueChange,
      onValueCommit,
      children: _children,
      ...props
    },
    ref,
  ) => {
    const isControlled = value !== undefined;
    const initialValue = React.useMemo(
      () => normalizeValues(defaultValue ?? [min], min, max, step),
      [defaultValue, min, max, step],
    );
    const [internalValue, setInternalValue] = React.useState<number[]>(initialValue);
    const values = React.useMemo(
      () => normalizeValues((isControlled ? value : internalValue) ?? [min], min, max, step),
      [isControlled, value, internalValue, min, max, step],
    );

    const rootRef = React.useRef<HTMLSpanElement | null>(null);
    const [activeIndex, setActiveIndex] = React.useState<number | null>(null);
    const lastCommittedRef = React.useRef(values);
    const valuesRef = React.useRef(values);
    const onValueChangeRef = React.useRef(onValueChange);
    const onValueCommitRef = React.useRef(onValueCommit);

    React.useEffect(() => {
      valuesRef.current = values;
      if (!isControlled) setInternalValue(values);
    }, [values, isControlled]);

    React.useEffect(() => {
      onValueChangeRef.current = onValueChange;
      onValueCommitRef.current = onValueCommit;
    }, [onValueChange, onValueCommit]);

    const emitValue = React.useCallback(
      (nextValues: number[]) => {
        const normalized = normalizeValues(nextValues, min, max, step);
        if (!isControlled) setInternalValue(normalized);
        onValueChangeRef.current?.(normalized);
        valuesRef.current = normalized;
      },
      [isControlled, min, max, step],
    );

    const commitValue = React.useCallback(() => {
      const current = valuesRef.current;
      if (current.toString() !== lastCommittedRef.current.toString()) {
        lastCommittedRef.current = current;
        onValueCommitRef.current?.(current);
      }
    }, []);

    const getTrackRect = React.useCallback(() => rootRef.current?.getBoundingClientRect(), []);

    const clampThumbValue = React.useCallback(
      (index: number, candidate: number, currentValues: number[]) => {
        const gap = minStepsBetweenThumbs * step;
        const lowerBound = index > 0 ? currentValues[index - 1] + gap : min;
        const upperBound = index < currentValues.length - 1 ? currentValues[index + 1] - gap : max;
        return clamp(candidate, lowerBound, upperBound);
      },
      [min, max, minStepsBetweenThumbs, step],
    );

    const updateFromClientX = React.useCallback(
      (clientX: number, thumbIndex: number) => {
        const rect = getTrackRect();
        if (!rect || rect.width <= 0) return;

        const raw = min + ((clientX - rect.left) / rect.width) * (max - min);
        const snapped = roundToStep(raw, step, min);

        const next = [...valuesRef.current];
        next[thumbIndex] = clampThumbValue(thumbIndex, snapped, next);
        emitValue(next);
      },
      [clampThumbValue, emitValue, getTrackRect, max, min, step],
    );

    React.useEffect(() => {
      if (activeIndex === null) return;

      const handlePointerMove = (event: PointerEvent) => {
        updateFromClientX(event.clientX, activeIndex);
      };

      const handlePointerUp = () => {
        setActiveIndex(null);
        commitValue();
      };

      window.addEventListener("pointermove", handlePointerMove);
      window.addEventListener("pointerup", handlePointerUp);

      return () => {
        window.removeEventListener("pointermove", handlePointerMove);
        window.removeEventListener("pointerup", handlePointerUp);
      };
    }, [activeIndex, commitValue, updateFromClientX]);

    const handleThumbPointerDown = (index: number) => (event: React.PointerEvent<HTMLSpanElement>) => {
      if (disabled) return;
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      setActiveIndex(index);
      updateFromClientX(event.clientX, index);
    };

    const handleTrackPointerDown = (event: React.PointerEvent<HTMLSpanElement>) => {
      if (disabled) return;
      if (event.target !== event.currentTarget) return;
      event.preventDefault();
      const rect = getTrackRect();
      if (!rect || rect.width <= 0) return;

      const raw = min + ((event.clientX - rect.left) / rect.width) * (max - min);
      const snapped = roundToStep(raw, step, min);
      const distances = valuesRef.current.map((current) => Math.abs(current - snapped));
      const closestIndex = distances.indexOf(Math.min(...distances));
      setActiveIndex(closestIndex);
      updateFromClientX(event.clientX, closestIndex);
    };

    const handleThumbKeyDown = (index: number) => (event: React.KeyboardEvent<HTMLSpanElement>) => {
      if (disabled) return;

      const multiplier = event.shiftKey || event.key === "PageUp" || event.key === "PageDown" ? 10 : 1;
      const direction =
        event.key === "ArrowRight" || event.key === "ArrowUp" || event.key === "PageUp" ? 1 :
        event.key === "ArrowLeft" || event.key === "ArrowDown" || event.key === "PageDown" ? -1 :
        0;

      if (event.key === "Home") {
        event.preventDefault();
        const next = [...valuesRef.current];
        next[index] = clampThumbValue(index, min, next);
        emitValue(next);
        commitValue();
        return;
      }

      if (event.key === "End") {
        event.preventDefault();
        const next = [...valuesRef.current];
        next[index] = clampThumbValue(index, max, next);
        emitValue(next);
        commitValue();
        return;
      }

      if (!direction) return;

      event.preventDefault();
      const next = [...valuesRef.current];
      next[index] = clampThumbValue(index, next[index] + direction * step * multiplier, next);
      emitValue(next);
      commitValue();
    };

    const thumbCount = values.length > 1 ? values.length : 1;
    const startPercent = max === min ? 0 : ((values[0] - min) / (max - min)) * 100;
    const endPercent = max === min ? 100 : ((values[values.length - 1] - min) / (max - min)) * 100;

    return (
      <span
        ref={ref}
        className={cn("relative flex w-full touch-none select-none items-center py-3", className)}
        aria-disabled={disabled}
        data-disabled={disabled ? "" : undefined}
        {...props}
      >
        <span
          ref={rootRef}
          className="relative h-8 w-full"
          onPointerDown={handleTrackPointerDown}
        >
          <span className="pointer-events-none absolute left-0 right-0 top-1/2 h-2 -translate-y-1/2 rounded-full bg-secondary" />
          <span
            className="pointer-events-none absolute top-1/2 z-0 h-2 -translate-y-1/2 rounded-full bg-primary"
            style={{
              left: `${Math.min(startPercent, endPercent)}%`,
              width: `${Math.max(0, endPercent - startPercent)}%`,
            }}
          />

          {Array.from({ length: thumbCount }).map((_, index) => {
            const valueAtIndex = values[index] ?? values[0];
            const percent = max === min ? 0 : ((valueAtIndex - min) / (max - min)) * 100;
            const label =
              values.length === 2
                ? DEFAULT_THUMB_LABELS[index] ?? `Thumb ${index + 1}`
                : `Value ${index + 1}`;

            return (
              <span
                key={`slider-thumb-${index}`}
                role="slider"
                tabIndex={disabled ? -1 : 0}
                aria-label={label}
                aria-valuemin={min}
                aria-valuemax={max}
                aria-valuenow={valueAtIndex}
                aria-orientation="horizontal"
                data-disabled={disabled ? "" : undefined}
                className={cn(
                  "absolute top-1/2 z-10 block h-5 w-5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-primary bg-background shadow-sm ring-offset-background",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
                  disabled ? "pointer-events-none opacity-50" : "cursor-grab active:cursor-grabbing",
                )}
                style={{ left: `${percent}%` }}
                onPointerDown={handleThumbPointerDown(index)}
                onKeyDown={handleThumbKeyDown(index)}
              />
            );
          })}
        </span>
      </span>
    );
  },
);

Slider.displayName = "Slider";

export { Slider };
