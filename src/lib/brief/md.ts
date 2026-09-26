// The master.md dialect, for the browser. The implementation is
// lib/brief-md.mjs — one module, so the MCP server's `file_document` and the
// Brief Desk parse and serialise identically (spec §3.2: "md.ts is the only
// place that knows the dialect"; it lives in lib/ because nothing under lib/
// or api/ can import src/).

export {
  parse,
  parseInline,
  serialize,
  serializeWithReport,
  toPlainText,
  emptyBrief,
  footnotesOf,
  SCHEMA_NAME,
  SCHEMA_VERSION,
  FLAG_KINDS,
} from '../../../lib/brief-md.mjs';
export type { BriefDoc, BriefNode, BriefMark } from '../../../lib/brief-md.mjs';
