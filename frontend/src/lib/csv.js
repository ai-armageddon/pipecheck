const encodeCell = (value) => {
  const text = value == null ? '' : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

export const rowsToCsv = (headers, rows) => [
  headers.map(encodeCell).join(','),
  ...rows.map(row => row.map(encodeCell).join(',')),
].join('\n');

export const jsonToCsv = (value) => {
  if (!Array.isArray(value) || value.length === 0 || value.some(row => !row || Array.isArray(row) || typeof row !== 'object')) {
    throw new Error('JSON must be a non-empty array of objects');
  }

  const headers = [...new Set(value.flatMap(row => Object.keys(row)))];
  if (headers.length === 0) throw new Error('JSON objects must contain at least one field');

  return rowsToCsv(headers, value.map(row => headers.map(header => {
    const cell = row[header];
    return cell && typeof cell === 'object' ? JSON.stringify(cell) : cell;
  })));
};

// Small RFC 4180-style parser for previews. It handles quoted delimiters,
// escaped quotes, and embedded newlines without pulling a second CSV parser
// into the browser bundle. The backend remains the source of truth.
export const parseCsv = (input) => {
  const text = String(input ?? '').replace(/^\uFEFF/, '');
  const counts = new Map([[',', 0], ['\t', 0], [';', 0], ['|', 0]]);
  let insideQuotes = false;
  for (const char of text.trimStart()) {
    if (char === '"') insideQuotes = !insideQuotes;
    if (insideQuotes) continue;
    if (char === '\n' || char === '\r') break;
    if (counts.has(char)) counts.set(char, counts.get(char) + 1);
  }
  const delimiter = [...counts].sort((a, b) => b[1] - a[1])[0][0];
  const records = [];
  let record = [];
  let field = '';
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];

    if (quoted) {
      if (char === '"' && next === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === '"' && field.length === 0) {
      quoted = true;
    } else if (char === delimiter) {
      record.push(field);
      field = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && next === '\n') index += 1;
      record.push(field);
      if (record.length > 1 || record[0].trim()) records.push(record);
      record = [];
      field = '';
    } else {
      field += char;
    }
  }

  record.push(field);
  if (record.length > 1 || record[0].trim()) records.push(record);
  if (records.length === 0) return { headers: [], rows: [] };

  return { headers: records[0], rows: records.slice(1) };
};
