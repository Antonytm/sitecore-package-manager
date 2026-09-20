"use client";

// Readme and License both show one read-only block of package-supplied text.

export function TextStep({ text }: { text: string }) {
  return (
    <pre className="max-h-[24rem] overflow-auto whitespace-pre-wrap p-6 text-sm">{text}</pre>
  );
}
