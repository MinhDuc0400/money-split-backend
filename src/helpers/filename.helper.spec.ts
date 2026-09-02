import { buildExportFilename } from './filename.helper';

describe('buildExportFilename', () => {
  it('keeps a normal ASCII group name unchanged in both variants', () => {
    expect(buildExportFilename('Trip to Japan')).toEqual({
      filename: 'Trip to Japan-expenses.xlsx',
      filenameUtf8: 'Trip to Japan-expenses.xlsx',
    });
  });

  it('strips filesystem-invalid characters from both variants', () => {
    expect(buildExportFilename('Rent/Bills?')).toEqual({
      filename: 'RentBills-expenses.xlsx',
      filenameUtf8: 'RentBills-expenses.xlsx',
    });
  });

  it('falls back to "group" when the name is entirely invalid characters', () => {
    expect(buildExportFilename('???')).toEqual({
      filename: 'group-expenses.xlsx',
      filenameUtf8: 'group-expenses.xlsx',
    });
  });

  it('falls back to "group" when the name is empty', () => {
    expect(buildExportFilename('')).toEqual({
      filename: 'group-expenses.xlsx',
      filenameUtf8: 'group-expenses.xlsx',
    });
  });

  it('keeps non-ASCII characters in filenameUtf8 but strips them from filename', () => {
    expect(buildExportFilename('Nhóm bạn 💰')).toEqual({
      filename: 'Nhm bn-expenses.xlsx',
      filenameUtf8: 'Nhóm bạn 💰-expenses.xlsx',
    });
  });
});
