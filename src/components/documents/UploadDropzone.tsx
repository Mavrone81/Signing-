"use client";

import { useCallback, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Card } from "@/components/ui/Card";
import { buttonClasses } from "@/components/ui/Button";
import {
  CLIENT_MAX_UPLOAD_MB,
  isLikelyPdf,
  isUnderClientSizeCap,
} from "@/lib/upload-validation";

type UploadState =
  | { phase: "idle" }
  | { phase: "uploading"; progress: number; fileName: string }
  | { phase: "error"; message: string };

function errorMessage(code: string | undefined): string {
  switch (code) {
    case "INVALID_PDF":
      return "That file is not a valid PDF.";
    case "TOO_LARGE":
      return `File exceeds the ${CLIENT_MAX_UPLOAD_MB} MB limit.`;
    case "MISSING_FILE":
      return "No file was received.";
    case "UNAUTHENTICATED":
      return "Your session has expired. Please sign in again.";
    default:
      return "Upload failed. Please try again.";
  }
}

export function UploadDropzone() {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [state, setState] = useState<UploadState>({ phase: "idle" });
  const [isDragging, setIsDragging] = useState(false);

  const upload = useCallback(
    (file: File) => {
      if (!isLikelyPdf(file)) {
        setState({ phase: "error", message: "Only PDF files are supported." });
        return;
      }
      if (!isUnderClientSizeCap(file)) {
        setState({
          phase: "error",
          message: `File exceeds the ${CLIENT_MAX_UPLOAD_MB} MB limit.`,
        });
        return;
      }

      setState({ phase: "uploading", progress: 0, fileName: file.name });

      const form = new FormData();
      form.append("file", file);

      const xhr = new XMLHttpRequest();
      xhr.open("POST", "/api/documents");
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) {
          setState({
            phase: "uploading",
            progress: Math.round((e.loaded / e.total) * 100),
            fileName: file.name,
          });
        }
      };
      xhr.onload = () => {
        if (xhr.status === 201) {
          setState({ phase: "idle" });
          // Parse the response and navigate to the document editor
          try {
            const { id } = JSON.parse(xhr.responseText);
            if (id) {
              router.push(`/documents/${id}/edit`);
              return;
            }
          } catch {
            // JSON parsing failed or id missing — fall back to refresh
          }
          router.refresh();
        } else {
          let code: string | undefined;
          try {
            code = JSON.parse(xhr.responseText)?.error;
          } catch {
            // non-JSON error body — fall through to the generic message
          }
          setState({ phase: "error", message: errorMessage(code) });
        }
      };
      xhr.onerror = () => {
        setState({ phase: "error", message: "Network error during upload." });
      };
      xhr.send(form);
    },
    [router]
  );

  const onDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      setIsDragging(false);
      const file = e.dataTransfer.files?.[0];
      if (file) upload(file);
    },
    [upload]
  );

  const onInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) upload(file);
      e.target.value = ""; // allow re-selecting the same file after an error
    },
    [upload]
  );

  const openPicker = useCallback(() => inputRef.current?.click(), []);
  const uploading = state.phase === "uploading";

  return (
    <div className="mb-6">
      <Card
        role="button"
        tabIndex={0}
        aria-label="Upload a PDF document"
        onClick={uploading ? undefined : openPicker}
        onKeyDown={(e) => {
          if (!uploading && (e.key === "Enter" || e.key === " ")) {
            e.preventDefault();
            openPicker();
          }
        }}
        onDragOver={(e) => {
          e.preventDefault();
          if (!uploading) setIsDragging(true);
        }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={uploading ? undefined : onDrop}
        className={`flex min-h-36 cursor-pointer flex-col items-center justify-center gap-2 border-2 border-dashed px-6 py-8 text-center transition-colors ${
          isDragging
            ? "border-brand-primary bg-brand-primary-tint"
            : "border-edge-strong bg-paper hover:border-brand-primary/60"
        } ${uploading ? "pointer-events-none opacity-70" : ""}`}
      >
        <input
          ref={inputRef}
          type="file"
          accept="application/pdf,.pdf"
          className="hidden"
          onChange={onInputChange}
          disabled={uploading}
        />

        {state.phase === "uploading" ? (
          <div className="w-full max-w-sm">
            <p className="text-[14px] font-medium text-ink">
              Uploading {state.fileName}…
            </p>
            <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-edge">
              <div
                className="h-full rounded-full bg-brand-primary transition-[width]"
                style={{ width: `${state.progress}%` }}
              />
            </div>
          </div>
        ) : (
          <>
            <p className="text-[14px] font-medium text-ink">
              Drag and drop a PDF here, or
            </p>
            <span className={buttonClasses("secondary", "sm")}>
              Browse files
            </span>
            <p className="text-[12px] text-subtle">
              PDF only, up to {CLIENT_MAX_UPLOAD_MB} MB.
            </p>
          </>
        )}
      </Card>

      {state.phase === "error" && (
        <p className="mt-2 text-[13px] text-danger" role="alert">
          {state.message}
        </p>
      )}
    </div>
  );
}
