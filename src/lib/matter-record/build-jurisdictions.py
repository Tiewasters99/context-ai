"""Build-time conversion of the AI Use Record rules matrix into the TypeScript
module bundled beside this file.

Source: the `ai-use-record` skill's `references/jurisdictions.yaml`
(default path below; pass another as argv[2]). The conversion is verbatim —
no field is reworded, summarised, reordered or dropped, and dates stay the
strings the YAML writes them as. The export prints `matrix_version`, and each
entry's own `status` / `verified_on`, so a `draft` row is never shown as
settled authority.

It emits a `.ts` module rather than a `.json` file for one dull reason: the
app's tsconfig does not set `resolveJsonModule`, and a build-time copy is no
use if `tsc` will not read it. JSON is valid TypeScript expression syntax, so
the emitted literal is the converted matrix and nothing else.

Run:  python src/lib/matter-record/build-jurisdictions.py \
          src/lib/matter-record/jurisdictions.ts

It exits non-zero if any `verbatim` quotation in the output cannot be found
in the YAML source text.
"""
import json
import sys
import yaml


class StringDates(yaml.SafeLoader):
    pass


StringDates.add_constructor(
    'tag:yaml.org,2002:timestamp',
    lambda loader, node: loader.construct_scalar(node),
)

DEFAULT_SRC = (
    r'C:\Users\equai\.claude\skills\ai-use-record'
    r'\references\jurisdictions.yaml'
)

OUT = sys.argv[1]
SRC = sys.argv[2] if len(sys.argv) > 2 else DEFAULT_SRC

with open(SRC, encoding='utf-8') as fh:
    raw = fh.read()

doc = yaml.load(raw, Loader=StringDates)

out = {
    'schema_version': doc.get('schema_version'),
    'matrix_version': doc.get('matrix_version'),
    'entries': doc.get('entries', []),
}

HEADER = f"""// GENERATED FILE — do not edit by hand.
//
// A build-time copy of the AI Use Record rules matrix
// (`references/jurisdictions.yaml` in the `ai-use-record` skill), matrix
// version {out['matrix_version']}, converted verbatim by
// build-jurisdictions.py in this folder. Nothing here is fetched at runtime
// and nothing here is reworded: the Matter Record export prints an entry's
// rule text, cites and `status` exactly as the matrix has them, and adds no
// legal characterisation of its own.
//
// Regenerate when the matrix version changes:
//   python src/lib/matter-record/build-jurisdictions.py \\
//       src/lib/matter-record/jurisdictions.ts

import type {{ JurisdictionMatrix }} from './types';

export const JURISDICTIONS: JurisdictionMatrix = """

body = json.dumps(out, ensure_ascii=False, indent=2)
text = HEADER + body + ';\n'
with open(OUT, 'w', encoding='utf-8', newline='\n') as fh:
    fh.write(text)

# Prove the conversion kept every quotation byte-for-byte: each `verbatim`
# string in the JSON must appear in the YAML source text. YAML folds long
# scalars across lines, so compare on collapsed whitespace.
haystack = ' '.join(raw.split())
missing = 0
checked = 0
for entry in out['entries']:
    for source in entry.get('sources') or []:
        quote = source.get('verbatim')
        if not isinstance(quote, str) or not quote.strip():
            continue
        checked += 1
        if ' '.join(quote.split()) not in haystack:
            missing += 1
            print('MISSING VERBATIM:', entry['id'], repr(quote[:70]))

print(f'entries={len(out["entries"])} matrix_version={out["matrix_version"]}')
print(f'verbatims checked={checked} missing={missing}')
print(f'bytes={len(text.encode("utf-8"))}')
sys.exit(1 if missing else 0)
