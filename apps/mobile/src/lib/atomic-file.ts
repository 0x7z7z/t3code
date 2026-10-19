import type { File } from "expo-file-system";

let tempFileSequence = 0;

/**
 * Use a distinct staging file per write so concurrent writers cannot clobber each other's temp file.
 * Remove failed staging files so retries cannot leak them.
 */
export async function writeFileAtomically(file: File, contents: string): Promise<void> {
  const { File: FileConstructor } = await import("expo-file-system");
  tempFileSequence += 1;
  const temp = new FileConstructor(file.parentDirectory, `${file.name}.${tempFileSequence}.tmp`);
  try {
    temp.create({ intermediates: true, overwrite: true });
    await temp.write(contents);
    temp.moveSync(file, { overwrite: true });
  } catch (error) {
    try {
      if (temp.exists) temp.delete();
    } catch {}
    throw error;
  }
}
