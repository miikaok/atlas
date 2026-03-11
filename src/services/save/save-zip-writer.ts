import { createWriteStream } from 'node:fs';
import archiver from 'archiver';

export interface SaveArchive {
  readonly archive: archiver.Archiver;
  readonly promise: Promise<number>;
}

/** Creates a zip archive with maximum compression, streaming to the output path. */
export function create_save_archive(output_path: string): SaveArchive {
  const output = createWriteStream(output_path);
  const archive = archiver('zip', { zlib: { level: 9 } });

  const promise = new Promise<number>((resolve, reject) => {
    output.on('close', () => resolve(archive.pointer()));
    archive.on('error', reject);
    output.on('error', reject);
  });

  archive.pipe(output);
  return { archive, promise };
}

/** Appends an EML buffer to the archive under folder_name/filename. */
export function add_eml_to_archive(
  archive: archiver.Archiver,
  folder_name: string,
  filename: string,
  content: Buffer,
): void {
  const path = `${sanitize_path_segment(folder_name)}/${filename}`;
  archive.append(content, { name: path });
}

/** Finalizes the archive. The returned promise resolves to total bytes written. */
export async function finalize_archive(archive: archiver.Archiver): Promise<void> {
  await archive.finalize();
}

function sanitize_path_segment(segment: string): string {
  return (
    segment
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
      .replace(/\.{2,}/g, '.')
      .replace(/^\.+|\.+$/g, '') || 'Unknown'
  );
}
