import { useEffect, useRef, useState } from "react";
import { css } from "../../styles/theme.js";

interface ModelAutocompleteProps {
  value: string;
  onChange: (value: string) => void;
  models: string[];
  placeholder?: string;
  loading?: boolean;
}

export function ModelAutocomplete({
  value,
  onChange,
  models,
  placeholder,
  loading,
}: ModelAutocompleteProps) {
  const [open, setOpen] = useState(false);
  const [highlighted, setHighlighted] = useState(-1);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const filtered = value.trim()
    ? models.filter((m) => m.toLowerCase().includes(value.toLowerCase()))
    : models;

  const showDropdown = open && filtered.length > 0;

  // Close on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  // Scroll highlighted item into view
  useEffect(() => {
    if (highlighted >= 0 && listRef.current) {
      const item = listRef.current.children[highlighted] as HTMLElement | undefined;
      item?.scrollIntoView({ block: "nearest" });
    }
  }, [highlighted]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!showDropdown) {
      if (e.key === "ArrowDown" && filtered.length > 0) {
        setOpen(true);
        setHighlighted(0);
        e.preventDefault();
      }
      return;
    }

    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setHighlighted((prev) => (prev + 1) % filtered.length);
        break;
      case "ArrowUp":
        e.preventDefault();
        setHighlighted((prev) => (prev <= 0 ? filtered.length - 1 : prev - 1));
        break;
      case "Enter":
        e.preventDefault();
        if (highlighted >= 0 && highlighted < filtered.length) {
          onChange(filtered[highlighted]);
          setOpen(false);
          setHighlighted(-1);
        }
        break;
      case "Escape":
        setOpen(false);
        setHighlighted(-1);
        break;
    }
  };

  const handleSelect = (model: string) => {
    onChange(model);
    setOpen(false);
    setHighlighted(-1);
    inputRef.current?.focus();
  };

  // If no models available, render a plain input
  if (models.length === 0 && !loading) {
    return (
      <input
        style={{ ...css.input, maxWidth: 400 }}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
      />
    );
  }

  return (
    <div ref={containerRef} style={{ position: "relative", maxWidth: 400 }}>
      <div style={{ position: "relative" }}>
        <input
          ref={inputRef}
          style={{ ...css.input, maxWidth: 400 }}
          value={value}
          onChange={(e) => {
            onChange(e.target.value);
            setOpen(true);
            setHighlighted(-1);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={handleKeyDown}
          placeholder={loading ? "Loading models..." : placeholder}
          autoComplete="off"
          role="combobox"
          aria-expanded={showDropdown}
          aria-autocomplete="list"
        />
        {models.length > 0 && (
          <span
            style={{
              position: "absolute",
              right: 8,
              top: "50%",
              transform: "translateY(-50%)",
              fontSize: 10,
              color: "var(--fg3)",
              pointerEvents: "none",
            }}
          >
            {filtered.length} model{filtered.length !== 1 ? "s" : ""}
          </span>
        )}
      </div>

      {showDropdown && (
        <div
          ref={listRef}
          role="listbox"
          style={{
            position: "absolute",
            top: "100%",
            left: 0,
            right: 0,
            maxHeight: 240,
            overflowY: "auto",
            background: "var(--bg2)",
            border: "1px solid var(--border)",
            borderTop: "none",
            borderRadius: "0 0 var(--radius) var(--radius)",
            margin: 0,
            padding: 0,
            zIndex: 100,
            boxShadow: "0 4px 12px rgba(0,0,0,0.15)",
          }}
        >
          {filtered.map((model, i) => {
            const isHighlighted = i === highlighted;
            const isSelected = model === value;
            return (
              <div
                key={model}
                role="option"
                tabIndex={-1}
                aria-selected={isSelected}
                onMouseDown={(e) => {
                  e.preventDefault();
                  handleSelect(model);
                }}
                onMouseEnter={() => setHighlighted(i)}
                style={{
                  padding: "6px 12px",
                  fontSize: 13,
                  fontFamily: "'SF Mono', Monaco, Consolas, monospace",
                  cursor: "pointer",
                  background: isHighlighted ? "var(--bg3)" : "transparent",
                  color: isSelected ? "var(--accent)" : "var(--fg)",
                  fontWeight: isSelected ? 600 : 400,
                  borderBottom: "1px solid var(--border)",
                }}
              >
                {model}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
