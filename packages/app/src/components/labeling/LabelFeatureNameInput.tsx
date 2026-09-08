import React, { useState } from "react";

interface LabelFeatureNameInputProps {
  /** The resolved label feature (override or dataset default). */
  value: string;
  placeholder: string;
  className?: string;
  /** Called with the trimmed draft on blur / Enter; empty means "dataset default". */
  onCommit: (next: string) => void;
}

/**
 * Text field for the label feature column. Holds a local draft while typing
 * so the field can be emptied without snapping back to the resolved value
 * (issue #352); the store is only updated on commit.
 */
export const LabelFeatureNameInput: React.FC<LabelFeatureNameInputProps> = ({
  value,
  placeholder,
  className,
  onCommit,
}) => {
  const [draft, setDraft] = useState<string | null>(null);

  const commit = () => {
    if (draft === null) return;
    setDraft(null);
    onCommit(draft.trim());
  };

  return (
    <input
      id="label-feature-name"
      type="text"
      value={draft ?? value}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
      }}
      placeholder={placeholder}
      className={className}
    />
  );
};
