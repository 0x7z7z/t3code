import type { FileBackedComposerAttachment } from "./composerImages";
import { retainComposerAttachmentFile } from "./composerAttachmentFiles";

/**
 * File ownership lives in state, which this module cannot import. Draft state registers the cleanup
 * hook at load time; before that no draft owners have loaded to require a sweep.
 */
type UnusedAttachmentHandler = (attachment: FileBackedComposerAttachment) => void;

let onAttachmentUnused: UnusedAttachmentHandler | null = null;

export function registerComposerAttachmentUnusedHandler(handler: UnusedAttachmentHandler): void {
  onAttachmentUnused = handler;
}

export function retainComposerAttachmentFileForPreview(
  attachment: FileBackedComposerAttachment,
): () => void {
  return retainComposerAttachmentFile(attachment.fileUri, () => {
    onAttachmentUnused?.(attachment);
  });
}
