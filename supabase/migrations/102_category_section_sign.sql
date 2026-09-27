-- 102_category_section_sign.sql — a "§" alone does not make a statute.
--
-- 081's document_category_rule filed any name containing "§" on the statute
-- shelf. In production that put seven notes on it — "Inventory §3 — Missing /
-- PACER Pull List (2026-09-18)" and its siblings in the DeCamara record matter
-- — beside the two real statutes there (09-27, found during the DeCamara cite
-- check). The rule now counts a section sign only where a statute puts one:
-- at the very front of the name, or after a code or a law ("… Code § 17.46",
-- "… Law § 349"). "28 U.S.C. §", "C.F.R.", "CPLR" and the rest are matched by
-- their own tests, unchanged. Everything else in the function is 081's,
-- word for word; scripts/_verify-vault-document-search.mjs runs 081 then this
-- file and holds the whole name table to both.
--
-- Then the shelf is corrected where the RULE put a document on it: only rows
-- with category = 'statute' and category_source = 'rule' are re-decided. A
-- person's choice (category_source = 'user') is never touched, and no other
-- shelf is re-sorted — that stays the matter's "Organize" button (081 §7).
--
-- Idempotent: re-pasting replaces the function with itself and re-decides
-- the same rows to the same answer.

create or replace function public.document_category_rule(p_title text, p_filename text)
returns text
language plpgsql
immutable
as $$
declare
  -- The displayed name first, exactly as the Vault shows it, then the other.
  v_raw   text := btrim(coalesce(nullif(btrim(coalesce(p_filename, '')), ''), p_title, ''));
  v_other text := btrim(coalesce(p_title, ''));
  v_name  text;
  v_low   text;
begin
  if v_raw = '' then return 'other'; end if;
  -- Sort-key normalisation first so a leading date or index does not hide the
  -- word that decides ("2026-09-08 Decl of Smith.pdf").
  v_name := public.document_sort_key(v_raw);
  v_low  := v_name || ' ' || public.document_sort_key(v_other);

  -- NOTE ON \y. PostgreSQL's regular expressions are AREs, where the word
  -- boundary is \y (\m start, \M end) and \b is a BACKSPACE character. Every
  -- boundary below is \y on purpose; a \b here would silently match nothing
  -- and quietly file half a matter under "other".

  -- 1. What the document IS, when it announces it at the front.
  if v_name ~ '^(ex|exh|exhibit|dx|px|attachment|appendix)\y[\s.:\-]*[0-9a-z]{0,4}[\s.:\-]'
     or v_name ~ '^(decl|declaration|aff|affid|affidavit|cert|certificate|verification)\y'
     or v_name ~ '^(dep|depo|deposition|transcript|tr)\y' then
    return 'supporting';
  end if;

  -- 2. Secondary authority. BEFORE statutes, because a treatise section is
  --    still a treatise: "Wright & Miller, Federal Practice § 1391" carries a
  --    § and is not a statute.
  if v_low ~ '(law review|l\.?\s?rev\.?\y|restatement|treatise|hornbook|handbook|wright (&|and) miller|moore''s federal|\ya\.?l\.?r\.?\y|law journal|\yj\.? of \y|practice commentar)' then
    return 'secondary';
  end if;

  -- 3. Rules of procedure and evidence.
  if v_low ~ '(fed\.?\s*r\.?\s*(civ|crim|app|evid|bankr)|\yf\.?r\.?(c\.?p|e|a\.?p|cr\.?p)\y|federal rules?|local (civil |criminal )?rule|l\.?\s?civ\.?\s?r\.?|\yl\.?r\.?\s*\d|\yrule\s*\d)' then
    return 'rule';
  end if;

  -- 4. Statutes and regulations. A section sign alone is NOT a statute
  --    (102): "Inventory §3 — Missing / PACER Pull List" is a note. It counts
  --    at the very front ("§ 1983 claims"), or after a code or a law
  --    ("Tex. Bus. & Com. Code § 17.46", "Gen. Bus. Law § 349"), or after a
  --    title number and its code ("28 U.S.C. §", matched by the U.S.C. test).
  --    The front is tested on the RAW strings, as "In re" is below: the sort
  --    key strips every leading non-letter, § included, so v_low never begins
  --    with one. "Any non-letters, then §" lets 081's own leading date or
  --    index through ("2026-09-18 04 - § 1983 outline") and still refuses
  --    "Inventory §3", whose first character is a letter.
  if v_raw ~* '^[^a-z]*§' or v_other ~* '^[^a-z]*§'
     or v_low ~ '(\y(code|law|laws|act|stat|stats|reg|regs|ordinance)\.?\s*§|u\.?\s?s\.?\s?c\.?\y|c\.?\s?f\.?\s?r\.?\y|\ycplr\y|\ystat\.|public law|pub\.?\s?l\.?\s*no|\yusc\y|\ynyc admin|admin\.? code)' then
    return 'statute';
  end if;

  -- 5. Cases. Two accepted captions, and a reporter cite:
  --      * "… v. Pepsi" / "… vs. Pepsi" — the abbreviation with its period,
  --        followed by a capitalised party. The left side may be anything
  --        ending in a word character, which is what lets "Soft Drink Workers
  --        Local 812 v. Pepsi" through.
  --      * "Watson v Long Island" — the BARE v, which only means a caption
  --        when a capitalised party stands on each side of it. That is what
  --        keeps "Motion v Draft.docx" out of the case shelf.
  --    "In re" is tested on the raw string, because document_sort_key has
  --    already stripped it from the front of v_name.
  if v_raw ~ '[A-Za-z0-9)\]]\s+vs?\.\s+[A-Z]'
     or v_raw ~ '[A-Z][A-Za-z.''&\-]*\s+v\s+[A-Z]'
     or v_low ~ '\d+\s+(u\.?s\.?|f\.?\s?(2d|3d|4th)|f\.?\s?supp\.?|s\.?\s?ct\.?|n\.?y\.?(s\.?)?\s?(2d|3d)?|a\.?d\.?\s?(2d|3d)?|misc\.?\s?(2d|3d)?|n\.?e\.?\s?(2d|3d)?|f\.?r\.?d\.?|l\.?\s?ed\.?)\s*\d+'
     or v_raw ~ '^\s*[Ii]n [Rr]e\y' then
    return 'case';
  end if;

  -- 6. Things filed with the court.
  if v_low ~ '(complaint|answer\y|\ymotion\y|memorandum|mem\.? of law|\ybrief\y|\yreply\y|opposition|\yopp\.|\yorder\y|notice of|petition|stipulation|summons|counterclaim|cross-?claim|subpoena|pleading|affirmation in (support|opposition)|judgment|\ydocket\y)' then
    return 'pleading';
  end if;

  -- 7. Everything that supports one, named anywhere in the string.
  if v_low ~ '(declaration|affidavit|exhibit|transcript|deposition|\yletter\y|e-?mail|correspondence|invoice|\yreport\y|statement|\ychart\y|photograph|\yphoto\y|records?\y|\ynotes?\y|contract|agreement)' then
    return 'supporting';
  end if;

  return 'other';
end $$;

comment on function public.document_category_rule(text, text) is
  'The deterministic document category: case / statute / rule / secondary / '
  'pleading / supporting / other, decided from the filename and title alone. '
  'No model is consulted. First match wins and the ORDER of the tests is the '
  'rule — see the body. A section sign counts toward statute only at the front '
  'or after a code or a law (102). IMMUTABLE; see document_sort_key''s comment.';

-- The rows the old rule put on the statute shelf, re-decided by the new one.
-- 'other' is re-decided too: 081 lost a leading § to the sort key, so a name
-- like "§ 1983 claims outline" sat under Other by the rule; the new test on the
-- raw name puts it on Statutes. Only the § test changed, so an 'other' row can
-- move to 'statute' and nowhere else. (Production had no such row on 09-27.)
update public.documents
   set category    = public.document_category_rule(title, source_filename),
       category_at = now()
 where category in ('statute', 'other')
   and category_source = 'rule'
   and public.document_category_rule(title, source_filename) is distinct from category;
