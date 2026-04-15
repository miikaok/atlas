/**
 * Pads a short label (e.g. folder name) to a fixed terminal column width,
 * truncating with '~' when needed. Used by backup/save/restore dashboards.
 */
export function pad_folder_column(name: string, width = 28): string {
  return name.length > width ? name.slice(0, width - 1) + '~' : name.padEnd(width);
}
