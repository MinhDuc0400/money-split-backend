// Deliberately stripping filesystem-invalid control characters (0x00-0x1F) from a filename.
// eslint-disable-next-line no-control-regex
const FILESYSTEM_INVALID_CHARS = /[<>:"/\\|?*\x00-\x1F]/g;

function stripInvalidChars(name: string): string {
  return name.replace(FILESYSTEM_INVALID_CHARS, '').trim().replace(/\s+/g, ' ');
}

export function buildExportFilename(groupName: string): {
  filename: string;
  filenameUtf8: string;
} {
  const stripped = stripInvalidChars(groupName);
  const safe = stripped.length > 0 ? stripped : 'group';

  const asciiOnly = safe.replace(/[^\x20-\x7E]/g, '').trim();
  const asciiSafe = asciiOnly.length > 0 ? asciiOnly : 'group';

  return {
    filename: `${asciiSafe}-expenses.xlsx`,
    filenameUtf8: `${safe}-expenses.xlsx`,
  };
}
