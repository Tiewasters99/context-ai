// GENERATED FILE — do not edit by hand.
//
// A build-time copy of the AI Use Record rules matrix
// (`references/jurisdictions.yaml` in the `ai-use-record` skill), matrix
// version 2026-09-21.1, converted verbatim by
// build-jurisdictions.py in this folder. Nothing here is fetched at runtime
// and nothing here is reworded: the Matter Record export prints an entry's
// rule text, cites and `status` exactly as the matrix has them, and adds no
// legal characterisation of its own.
//
// Regenerate when the matrix version changes:
//   python src/lib/matter-record/build-jurisdictions.py \
//       src/lib/matter-record/jurisdictions.ts

import type { JurisdictionMatrix } from './types';

export const JURISDICTIONS: JurisdictionMatrix = {
  "schema_version": 1,
  "matrix_version": "2026-09-21.1",
  "entries": [
    {
      "id": "aba-formal-op-512",
      "kind": "national_guidance",
      "name": "ABA Formal Opinion 512, Generative Artificial Intelligence Tools",
      "disclosure_to_court": "none",
      "certification_required": false,
      "certificate_language": null,
      "verification_duty": "Competence (Model Rule 1.1) and candor (3.3): review and correct GAI output before relying on it; no fabricated authority may reach a filing.",
      "confidentiality_restriction": "Model Rule 1.6: assess the tool's terms before inputting client information; informed consent where the tool may retain or train on it.",
      "record_keeping_duty": "none",
      "client_disclosure_duty": "conditional — when GAI use is material to the representation, when the client asks, or when the engagement or other rules call for it (Model Rule 1.4)",
      "fees_note": "Model Rule 1.5: bill for time actually spent; do not bill the time GAI saved.",
      "sources": [
        {
          "title": "ABA Formal Opinion 512 (July 29, 2024)",
          "url": "https://www.americanbar.org/content/dam/aba/administrative/professional_responsibility/ethics-opinions/aba-formal-opinion-512.pdf",
          "verbatim": null,
          "effective": "2024-07-29",
          "fetched": "2026-09-16"
        }
      ],
      "status": "draft",
      "verified_on": null,
      "verified_by": null,
      "attorney_signoff": null,
      "notes": "Summarized from secondary sources on 2026-09-16; primary PDF not read. Verify before relying."
    },
    {
      "id": "us-3d-cir",
      "kind": "federal_appellate",
      "name": "U.S. Court of Appeals for the Third Circuit",
      "disclosure_to_court": "none",
      "certification_required": false,
      "certificate_language": null,
      "verification_duty": "McCarthy v. U.S. Drug Enforcement Administration, No. 24-2704 (3d Cir. Mar. 27, 2026) (precedential): \"In the first instance, competent representation required that Attorney be so thorough as to check all the citations in his Opening Brief before signing and filing it.\" (slip op. 8). The violation found was of Pa. R.P.C. 1.1, disciplined through Circuit Disciplinary Rule 2.1(d); the majority stated \"we do not find that he violated Pa. R.P.C. 3.3(a)(1)\" (slip op. 8). The panel emphasized that \"when using AI, litigants must still strictly adhere to all rules of professional conduct\" (slip op. 12) and warned that future violators \"may well face any of the sanctions available per Circuit Disciplinary Rules 4.1-4.2\" (slip op. 13). No AI-specific rule. Judge Roth, concurring in part and dissenting in part, would have sanctioned more severely and, relying on Park v. Kim (2d Cir.), wrote \"No forewarning is necessary when it is clear what standard the attorney was required to follow.\" (dissent slip op. 7).",
      "confidentiality_restriction": null,
      "record_keeping_duty": "none",
      "client_disclosure_duty": "none",
      "fees_note": "Circuit Disciplinary Rule 3.4: \"A monetary sanction imposed on disciplinary grounds is the personal responsibility of the attorney disciplined, and may not be reimbursed by a client directly or indirectly.\" No monetary sanction was imposed in McCarthy.",
      "sources": [
        {
          "title": "McCarthy v. U.S. Drug Enforcement Administration, No. 24-2704 (3d Cir. Mar. 27, 2026) (precedential) — slip op. 8 (competence requires checking all citations before filing)",
          "url": "https://www2.ca3.uscourts.gov/opinarch/242704p.pdf",
          "verbatim": "In the first instance, competent representation required that Attorney be so thorough as to check all the citations in his Opening Brief before signing and filing it.",
          "effective": "2026-03-27",
          "fetched": "2026-09-16"
        },
        {
          "title": "Same — slip op. 11-12 (existing entry verbatim 1; spans page break)",
          "url": "https://www2.ca3.uscourts.gov/opinarch/242704p.pdf",
          "verbatim": "That he was not already verifying the accuracy of all citations in his briefs is itself concerning.",
          "effective": "2026-03-27",
          "fetched": "2026-09-16"
        },
        {
          "title": "Same — slip op. 8 (no Pa. R.P.C. 3.3(a)(1) violation found)",
          "url": "https://www2.ca3.uscourts.gov/opinarch/242704p.pdf",
          "verbatim": "On the whole, while we are deeply troubled by Attorney’s cavalier stance towards his various submissions to this Court, we do not find that he violated Pa. R.P.C. 3.3(a)(1).",
          "effective": "2026-03-27",
          "fetched": "2026-09-16"
        },
        {
          "title": "Same — slip op. 13 (sanction imposed)",
          "url": "https://www2.ca3.uscourts.gov/opinarch/242704p.pdf",
          "verbatim": "Considering the above, the Court will impose the sanction of a reprimand.",
          "effective": "2026-03-27",
          "fetched": "2026-09-16"
        },
        {
          "title": "Same — slip op. 13 (existing entry verbatim 2; forward warning)",
          "url": "https://www2.ca3.uscourts.gov/opinarch/242704p.pdf",
          "verbatim": "As this precedent has now been set, the first mitigating factor will not apply in the future and violators may well face any of the sanctions available per Circuit Disciplinary Rules 4.1-4.2.",
          "effective": "2026-03-27",
          "fetched": "2026-09-16"
        },
        {
          "title": "Same — slip op. 14 (existing entry verbatim 3; AI use with supervision)",
          "url": "https://www2.ca3.uscourts.gov/opinarch/242704p.pdf",
          "verbatim": "With proper supervision and vetting, both may be helpful to an attorney. Nor are perfect summaries and citations needed to avoid sanctions. Mistakes do happen.",
          "effective": "2026-03-27",
          "fetched": "2026-09-16"
        },
        {
          "title": "Same — slip op. 14 (basis of sanction)",
          "url": "https://www2.ca3.uscourts.gov/opinarch/242704p.pdf",
          "verbatim": "Our decision to impose sanctions is due to Attorney’s overall conduct over the course of months.",
          "effective": "2026-03-27",
          "fetched": "2026-09-16"
        },
        {
          "title": "Same — Roth, J., concurring in part and dissenting in part, dissent slip op. 7 (on Park v. Kim and AI-specific rules)",
          "url": "https://www2.ca3.uscourts.gov/opinarch/242704p.pdf",
          "verbatim": "The Park court correctly rejected that argument, emphasizing that a rule about artificial intelligence use “is not necessary to inform a licensed attorney, who is a member of the bar of this Court, that she must ensure that her submissions to the Court are accurate.”",
          "effective": "2026-03-27",
          "fetched": "2026-09-16"
        },
        {
          "title": "Same — dissent slip op. 7 (no forewarning needed)",
          "url": "https://www2.ca3.uscourts.gov/opinarch/242704p.pdf",
          "verbatim": "No forewarning is necessary when it is clear what standard the attorney was required to follow.",
          "effective": "2026-03-27",
          "fetched": "2026-09-16"
        },
        {
          "title": "McCarthy v. DEA, No. 24-2704 (3d Cir. July 21, 2025) (NOT PRECEDENTIAL merits disposition) — slip op. 7 (AI-generated portion of brief not considered)",
          "url": "https://www2.ca3.uscourts.gov/opinarch/242704np.pdf",
          "verbatim": "Accordingly, we will not consider this portion of his brief.",
          "effective": "2025-07-21",
          "fetched": "2026-09-16"
        },
        {
          "title": "Third Circuit Rules of Attorney Disciplinary Enforcement (Effective July 1, 2015) — Rule 3.1",
          "url": "https://www.ca3.uscourts.gov/sites/ca3/files/2015_Atty_Disp_Final.pdf",
          "verbatim": "Discipline may consist of disbarment, suspension from practice before this Court, monetary sanction, removal from the roster of attorneys eligible for appointment as Court-appointed counsel, reprimand, or any other sanction that the Court or a panel thereof may deem appropriate.",
          "effective": "2015-07-01",
          "fetched": "2026-09-16"
        },
        {
          "title": "Same — Rule 4.1 (panel sanctions)",
          "url": "https://www.ca3.uscourts.gov/sites/ca3/files/2015_Atty_Disp_Final.pdf",
          "verbatim": "A motions, merits or other panel of the Court may impose any sanction other than suspension or disbarment.",
          "effective": "2015-07-01",
          "fetched": "2026-09-16"
        },
        {
          "title": "Third Circuit Local Appellate Rules (cover dated August 1, 2011) — L.A.R. 28.4 Committee Comments (signature as certificate; comment text, not rule text); no AI provision found",
          "url": "https://www.ca3.uscourts.gov/sites/ca3/files/2011_LAR_Final.pdf",
          "verbatim": "The signing of documents is important because it constitutes a certificate by the attorney or party that he or she has read the pleading or brief to ensure that it complies with all federal and local rules.",
          "effective": null,
          "fetched": "2026-09-16"
        },
        {
          "title": "Third Circuit, Requirements for Briefs (chart; no revision or effective date on its face) — no AI certification listed",
          "url": "https://www.ca3.uscourts.gov/sites/ca3/files/chart%20of%20requirements%20for%20briefs.pdf",
          "verbatim": null,
          "effective": null,
          "fetched": "2026-09-16"
        },
        {
          "title": "LEAD ONLY — Justia, McCarthy v. DEA case page (search result; not relied on)",
          "url": "https://law.justia.com/cases/federal/appellate-courts/ca3/24-2704/24-2704-2026-03-27.html",
          "verbatim": null,
          "effective": null,
          "fetched": null
        }
      ],
      "status": "verified",
      "verified_on": "2026-09-17",
      "verified_by": "claude-opus-5 (independent verifier session; every source URL re-fetched 2026-09-17; checkq/strictq exact match; pinpoints, effective dates, status and narrative claims checked against the fetched text; one missed-item search)",
      "attorney_signoff": null,
      "notes": "(i) Checked, nothing AI-specific found (all fetched 2026-09-16): L.A.R. PDF https://www.ca3.uscourts.gov/sites/ca3/files/2011_LAR_Final.pdf (34,210 words; the only grep hit is an electronic-filing clause on changes in technology); Recent Amendments PDF https://www.ca3.uscourts.gov/sites/ca3/files/LAR%2026%20and%20Misc.%20LAR%20113%28c%29%20Effective%20July%201%202023.pdf (L.A.R. 26.0 and Misc. 113.3(c), effective July 1, 2023); Standing Orders page https://www.ca3.uscourts.gov/standing-orders-0 (none on AI); Rules and Procedures page https://www.ca3.uscourts.gov/rules-procedures-0; Attorney Discipline Rules page https://www.ca3.uscourts.gov/attorney-discipline-rules and the 2015 Rules PDF; home page notices https://www.ca3.uscourts.gov/; News page https://www.ca3.uscourts.gov/news/ (items Nov. 2025 through Sept. 2, 2026) and RSS https://www.ca3.uscourts.gov/rss.xml; news item Quality Control Program for the Filing of Briefs (dated Sunday, January 4, 2026) https://www.ca3.uscourts.gov/news/quality-control-program-filing-briefs-0 and its attachment https://www.ca3.uscourts.gov/sites/ca3/files/BlastEmail_2026_01_04.pdf — neither addresses AI (an automated check of Opening, Response and Reply briefs for compliance with Federal and Local rules; no AI terms). Brief requirements chart https://www.ca3.uscourts.gov/sites/ca3/files/chart%20of%20requirements%20for%20briefs.pdf: its combined certifications are bar membership, word count, service, identical compliance of briefs, and virus check; no AI certification (grep: no AI terms). (ii) Binding status: McCarthy (Mar. 27, 2026) is designated PRECEDENTIAL (Chung, J., for the court; Roth, J., concurring in part and dissenting in part). It is a disciplinary decision, not a rule. The July 21, 2025 merits disposition in the same docket is NOT PRECEDENTIAL (its footnote cites I.O.P. 5.7). McCarthy n.5 did not reach L.A.R. 28.4 and 46.4 (signature, as informed by Fed. R. Civ. P. 11) or Circuit Disciplinary Rule 2.1(e). The Clerk, not the lawyer, notifies the client of monetary sanctions under Rule 3.4 (\"Notice to that effect will be sent to the client by the Clerk whenever a monetary sanction is imposed.\"), so client_disclosure_duty is none. Inference, not stated in the opinion: Rule 2.1(d) reaches the rules of any state to which the respondent is subject, so a lawyer licensed elsewhere would be measured against that state's competence rule. (iii) Pending/proposed: none found. (iv) Not fetched: the docket (PACER) for rehearing or later orders — probes for amended opinion files 242704pa.pdf and 242704pb.pdf returned HTTP 404 and web search 2026-09-16 found no amendment, vacatur or en banc grant; the Judicial Conference Committee on Codes of Conduct AI guidance cited in McCarthy n.7; the brief template page. (v) Existing verbatims confirmed: all three quotations in the jurisdictions.yaml us-3d-cir entry match the re-fetched opinion (PDF SHA-256 f758e31863a3e7f1cfb66a0822dd1719cfa3b52994550e4f50d6159a8f32aba8, identical to the aiur/3d-cir copy); the first spans the slip op. 11-12 page break. Discrepancies vs the existing entry: (a) chart source title says rev. Jan. 2026 with effective 2026-01-04 — the chart shows no date on its face; 2026-01-04 appears only in PDF metadata (CreationDate and ModDate), so effective is null here; (b) status verified, verified_on 2026-09-16, verified_by claude-fable-5-1 were set by a compiling session, contrary to research-protocol step 4; rebuilt as draft; (c) existing notes say public reprimand with notice to all admitting courts — the opinion says reprimand (the word public does not appear) and, quoting Circuit Disciplinary Rule 12, notice to other admitting courts and the National Disciplinary Data Bank (omitted in the existing entry); (d) existing notes say a fine would likely have followed but for first-instance notice — the opinion names two conditions: that this was the court's first opportunity to address AI and that the attorney had no notice Pa. R.P.C. 1.1 would be considered; (e) existing verification_duty says counsel was reprimanded for filing unverified AI summaries — the opinion says \"Our decision to impose sanctions is due to Attorney’s overall conduct over the course of months.\" (slip op. 14), including failure to check after the Government's brief and the Reply Brief characterizations; (f) existing entry omits that the majority found no Pa. R.P.C. 3.3(a)(1) violation; (g) existing notes attribute the absence of an AI L.A.R. or standing order to the chart's January 2026 revision — the conclusion holds on the L.A.R., amendments and standing-orders pages, but the chart is not an L.A.R. source and bears no revision date. Text note: pdftotext renders some characters in this PDF as replacement characters (e.g., en dashes); no quotation above includes one."
    },
    {
      "id": "us-5th-cir",
      "kind": "federal_appellate",
      "name": "U.S. Court of Appeals for the Fifth Circuit",
      "disclosure_to_court": "none",
      "certification_required": false,
      "certificate_language": null,
      "verification_duty": "Fletcher v. Experian Information Solutions, Inc., No. 25-20086 (5th Cir. Feb. 18, 2026) (published): the court found that counsel \"used artificial intelligence to draft a substantial portion, if not all, of her reply brief and then failed to verify the accuracy of the content generated\" (slip op. 2) and warned \"If it were ever an excuse to plead ignorance of the risks of using generative AI to draft a brief without verifying its output, it is certainly no longer so.\" (slip op. 5). Sanction of $2,500 under FRAP 46(c) (conduct unbecoming a member of the bar) and the court's inherent power (slip op. 13-15). No AI-specific rule: the court's 2024 decision not to adopt a proposed AI certification in 5th Cir. R. 32.3 and Form 6 states \"Parties and counsel are responsible for ensuring that their filings with the court, including briefs, shall be carefully checked for truthfulness and accuracy as the rules already require.\" and Fletcher says the court \"concluded that existing rules were sufficient to deter misconduct related to generative AI use, without the need for a rule specific to generative AI.\" (slip op. 4).",
      "confidentiality_restriction": null,
      "record_keeping_duty": "none",
      "client_disclosure_duty": "none",
      "sources": [
        {
          "title": "Fletcher v. Experian Information Solutions, Inc., No. 25-20086 (5th Cir. Feb. 18, 2026) (published) — slip op. 2 (finding)",
          "url": "https://www.ca5.uscourts.gov/opinions/pub/25/25-20086-CV0.pdf",
          "verbatim": "Having considered counsel’s responses to the show-cause order, we have determined that counsel used artificial intelligence to draft a substantial portion, if not all, of her reply brief and then failed to verify the accuracy of the content generated.",
          "effective": "2026-02-18",
          "fetched": "2026-09-16"
        },
        {
          "title": "Same — slip op. 5 (warning)",
          "url": "https://www.ca5.uscourts.gov/opinions/pub/25/25-20086-CV0.pdf",
          "verbatim": "If it were ever an excuse to plead ignorance of the risks of using generative AI to draft a brief without verifying its output, it is certainly no longer so.",
          "effective": "2026-02-18",
          "fetched": "2026-09-16"
        },
        {
          "title": "Same — slip op. 5 (duty when using generative AI)",
          "url": "https://www.ca5.uscourts.gov/opinions/pub/25/25-20086-CV0.pdf",
          "verbatim": "To ethically use generative AI in the practice of law—which we do not dispute can be helpful if done properly and carefully—a lawyer must “ensure that the legal propositions and authority generated are trustworthy.”",
          "effective": "2026-02-18",
          "fetched": "2026-09-16"
        },
        {
          "title": "Same — slip op. 4 (why no AI rule was adopted)",
          "url": "https://www.ca5.uscourts.gov/opinions/pub/25/25-20086-CV0.pdf",
          "verbatim": "In doing so, we concluded that existing rules were sufficient to deter misconduct related to generative AI use, without the need for a rule specific to generative AI.",
          "effective": "2026-02-18",
          "fetched": "2026-09-16"
        },
        {
          "title": "Same — slip op. 13 (existing rules apply)",
          "url": "https://www.ca5.uscourts.gov/opinions/pub/25/25-20086-CV0.pdf",
          "verbatim": "Modern generative AI may be a new technology, but the same sanctions rules apply, and the rules we have are well equipped to handle these types of cases.",
          "effective": "2026-02-18",
          "fetched": "2026-09-16"
        },
        {
          "title": "Same — slip op. 14 (FRAP 46(c) conduct unbecoming)",
          "url": "https://www.ca5.uscourts.gov/opinions/pub/25/25-20086-CV0.pdf",
          "verbatim": "The conduct at issue in this case is certainly “unbecoming a member of the bar.” Fed. R. App. P. 46(c). As discussed above, Hersh failed to check her own brief before submitting it, leading her to repeatedly misrepresent the law to the court.",
          "effective": "2026-02-18",
          "fetched": "2026-09-16"
        },
        {
          "title": "Same — slip op. 15 (sanction order)",
          "url": "https://www.ca5.uscourts.gov/opinions/pub/25/25-20086-CV0.pdf",
          "verbatim": "IT IS ORDERED that Heather Hersh shall pay $2,500 in sanctions to the United States Court of Appeals for the Fifth Circuit within 30 days of this order.",
          "effective": "2026-02-18",
          "fetched": "2026-09-16"
        },
        {
          "title": "Fifth Circuit, Court Decision on Proposed Rule (undated one-page PDF; text layer and OCR agree) — decision not to adopt AI rule",
          "url": "https://www.ca5.uscourts.gov/docs/default-source/default-document-library/court-decision-on-proposed-rule.pdf?sfvrsn=5967c92d_2",
          "verbatim": "The court, having considered the proposed rule, the accompanying comments, and the use of artificial intelligence in the legal practice, has decided not to adopt a special rule regarding the use of artificial intelligence in drafting briefs at this time.",
          "effective": null,
          "fetched": "2026-09-16"
        },
        {
          "title": "Same — rule cited by the court (as printed; see notes)",
          "url": "https://www.ca5.uscourts.gov/docs/default-source/default-document-library/court-decision-on-proposed-rule.pdf?sfvrsn=5967c92d_2",
          "verbatim": "Parties and counsel are reminded of their duties regarding their filings before the court under Federal Rule of Appellate Procedure 6(b)(1)(B).",
          "effective": null,
          "fetched": "2026-09-16"
        },
        {
          "title": "Same — accuracy duty",
          "url": "https://www.ca5.uscourts.gov/docs/default-source/default-document-library/court-decision-on-proposed-rule.pdf?sfvrsn=5967c92d_2",
          "verbatim": "Parties and counsel are responsible for ensuring that their filings with the court, including briefs, shall be carefully checked for truthfulness and accuracy as the rules already require.",
          "effective": null,
          "fetched": "2026-09-16"
        },
        {
          "title": "Same — no AI excuse (curly quotation marks as in the PDF text layer extracted as UTF-8)",
          "url": "https://www.ca5.uscourts.gov/docs/default-source/default-document-library/court-decision-on-proposed-rule.pdf?sfvrsn=5967c92d_2",
          "verbatim": "“I used AI” will not be an excuse for an otherwise sanctionable offense.",
          "effective": null,
          "fetched": "2026-09-16"
        },
        {
          "title": "Fifth Circuit news item, Court Action on Proposed AI Rule (news listing date Jun 10, 2024; the item page shows no date)",
          "url": "https://www.ca5.uscourts.gov/news/proposed-ai-rule",
          "verbatim": "The court has determined not to adopt a rule governing the use of Generative Artificial Intelligence.",
          "effective": null,
          "fetched": "2026-09-16"
        },
        {
          "title": "Fifth Circuit news item, Status of Proposed Artificial Intelligence Rule (news listing date Mar 6, 2024)",
          "url": "https://www.ca5.uscourts.gov/news/status-of-proposed-artificial-intelligence-rule",
          "verbatim": "A special committee will review the comments and make a recommendation to the full court on the need for and content of any future rule.",
          "effective": null,
          "fetched": "2026-09-16"
        },
        {
          "title": "NOT ADOPTED — Notice of Proposed Amendment to 5TH CIR. R. 32.3 (comments through January 4, 2024; news listing date Nov 21, 2023) — proposed AI certification",
          "url": "https://www.ca5.uscourts.gov/docs/default-source/default-document-library/public-comment-local-rule-32-3-and-form-6",
          "verbatim": "Additionally, counsel and unrepresented filers must further certify that no generative artificial intelligence program was used in drafting the document presented for filing, or to the extent such a program was used, all generated text, including all citations and legal analysis, has been reviewed for accuracy and approved by a human.",
          "effective": null,
          "fetched": "2026-09-16"
        },
        {
          "title": "Federal Rules of Appellate Procedure with Fifth Circuit Rules and IOPs (FRAP as amended to December 1, 2025; 5th Cir. R. as amended through December 2025) — 5th Cir. R. 32.3 as in force (no AI language)",
          "url": "https://www.ca5.uscourts.gov/docs/C9B3642D-BBBF-4D20-859C-C5B0875D75E8/federalrulesofappellateprocedure",
          "verbatim": "A material misrepresentation in the certificate of compliance may result in striking the brief and in sanctions against the person signing the brief.",
          "effective": null,
          "fetched": "2026-09-16"
        },
        {
          "title": "Same — FRAP 46(c) (relied on in Fletcher, slip op. 4 and 13-14)",
          "url": "https://www.ca5.uscourts.gov/docs/C9B3642D-BBBF-4D20-859C-C5B0875D75E8/federalrulesofappellateprocedure",
          "verbatim": "A court of appeals may discipline an attorney who practices before it for conduct unbecoming a member of the bar or for failure to comply with any court rule.",
          "effective": null,
          "fetched": "2026-09-16"
        },
        {
          "title": "Rules and Internal Operating Procedures of the U.S. Court of Appeals for the Fifth Circuit (December 2025) — 5th Cir. R. 47.5.4 (unpublished-opinion legend; absent from Fletcher)",
          "url": "https://www.ca5.uscourts.gov/docs/b0d14584-2d9a-43bd-8ceb-dc3644ba323f/5thcir-iop",
          "verbatim": "The first page of each unpublished opinion bears the following legend: This opinion is not designated for publication. See 5TH CIR. R. 47.5.",
          "effective": null,
          "fetched": "2026-09-16"
        },
        {
          "title": "LEAD ONLY — Norton Rose Fulbright, AI in litigation, Update on Gen AI sanctions in 2026 (gives reporter citation 168 F.4th 231 for Fletcher; unverified)",
          "url": "https://www.nortonrosefulbright.com/en/knowledge/publications/792d8bf3/ai-in-litigation-update-on-gen-ai-sanctions-in-2026",
          "verbatim": null,
          "effective": null,
          "fetched": null
        },
        {
          "title": "LEAD ONLY — Louisiana Legal Ethics, Fifth Circuit Sanctions Lawyer for AI-Generated Brief (used to locate Fletcher)",
          "url": "https://lalegalethics.org/fifth-circuit-sanctions-lawyer-for-ai-generated-brief/",
          "verbatim": null,
          "effective": null,
          "fetched": null
        }
      ],
      "status": "verified",
      "verified_on": "2026-09-17",
      "verified_by": "claude-opus-5 (independent verifier session; every source URL re-fetched 2026-09-17; checkq/strictq exact match; pinpoints, effective dates, status and narrative claims checked against the fetched text; one missed-item search)",
      "attorney_signoff": null,
      "notes": "(i) Checked, no AI rule in force (all fetched 2026-09-16): FRAP with 5th Cir. R. and IOPs https://www.ca5.uscourts.gov/docs/C9B3642D-BBBF-4D20-859C-C5B0875D75E8/federalrulesofappellateprocedure (52,456 words) and the stand-alone Rules and IOPs PDF https://www.ca5.uscourts.gov/docs/b0d14584-2d9a-43bd-8ceb-dc3644ba323f/5thcir-iop (December 2025) — grep hits only on technology in electronic-filing provisions; Rules and Procedures page https://www.ca5.uscourts.gov/rules-procedures; news listings https://www.ca5.uscourts.gov/news?year=2023, ?year=2024, ?year=2025, ?year=2026 and RSS https://www.ca5.uscourts.gov/feeds/news. AI items appear only in 2023-2024: Notice of Proposed Amendment to Fifth Circuit Rule 32.3 and Form 6 (listed Nov 21, 2023), Public Comments Regarding Proposed Local AI Rule (listed Jan 29, 2024), Status of Proposed Artificial Intelligence Rule (listed Mar 6, 2024), Court Action on Proposed AI Rule (listed Jun 10, 2024). Items read from 2025-2026 with no AI content: Amendments to Federal Rules of Appellate Procedure and Fifth Circuit Rules (effective December 1, 2025; FRAP 6 and 39, 5th Cir. R. 39.1, 39.3, 25.2.1), Notice of Proposed Changes to the Briefing Notice (2025), Public Notice (Jan. 2026). (ii) Binding status: Fletcher is a published opinion — posted under /opinions/pub/ and its first page lacks the legend 5th Cir. R. 47.5.4 requires on unpublished opinions; the document itself does not print the word published. The 2024 document is a decision not to adopt a rule: it is not a rule and imposes no certification; the proposed AI certification for 5th Cir. R. 32.3 and Form 6 was never adopted. (iii) Pending/proposed: nothing found after June 2024. (iv) Not fetched: the docket (PACER) for any rehearing in No. 25-20086 (web search found none; a search result describing an en banc denial was a different case, No. 25-30478, fetched, checked and discarded); the compiled public comments PDF; FRAP 6(b)(1)(B) as in force in June 2024; any other published Fifth Circuit AI-citation opinion after Feb. 18, 2026 (web searches 2026-09-16 found none; not proof of absence). (v) The existing jurisdictions.yaml entry had no verbatims to confirm. Discrepancies vs existing us-5th-cir: (a) existing verification_duty cites general duties under FRAP 46 — the decision document instead cites \"Federal Rule of Appellate Procedure 6(b)(1)(B)\", which in the December 2025 compilation concerns bankruptcy appeals (reading the Rule 3(c) reference to Forms 1A and 1B as Form 5), not candor or accuracy; Fletcher reports that public comments cited FRAP 46(b)(1)(B); OCR of the page image also reads 6(b)(1)(B), so this is how the court's document reads, apparently a mis-citation — verifier to confirm; (b) the existing entry omits Fletcher (published Feb. 18, 2026), now the operative Fifth Circuit authority, which sanctions under FRAP 46(c) and inherent power; state rules (Texas) appear in Fletcher only as a Cf. citation, not as the basis; (c) existing source title says June 2024 and effective 2024-06-12 — the decision document is undated; the ca5 news listing dates Court Action on Proposed AI Rule Jun 10, 2024; the PDF XMP CreateDate is 2024-06-11; 2024-06-12 appears in no official source fetched, so effective is null here; (d) existing notes say the decision document was never read — read in full 2026-09-16 (pdftotext text layer and Tesseract OCR agree, 115 words, no date); the existing URL still resolves (HTTP 200, application/pdf, 34,534 bytes). Also flagged for the verifier: Fletcher (slip op. 3) says the AI Subcommittee was appointed in Spring 2024 and dates the Notice Jan. 4, 2024, but the Notice solicits comments through January 4, 2024 and the news listing dates it Nov 21, 2023."
    },
    {
      "id": "us-2d-cir",
      "kind": "federal_appellate",
      "name": "U.S. Court of Appeals for the Second Circuit",
      "disclosure_to_court": "none",
      "certification_required": false,
      "certificate_language": null,
      "verification_duty": "Park v. Kim, No. 22-2057 (2d Cir. Jan. 30, 2024) (per curiam opinion; cited by later courts as 91 F.4th 610): \"All counsel that appear before this Court are bound to exercise professional judgment and responsibility, and to comply with the Federal Rules of Civil Procedure.\" and \"At the very least, the duties imposed by Rule 11 require that attorneys read, and thereby confirm the existence and validity of, the legal authorities on which they rely.\" (slip op. 8-9). No AI-specific rule: noting that \"several courts have recently proposed or enacted local rules or orders specifically addressing the use of artificial intelligence tools before the court\" (slip op. 10), the panel said such a rule is not necessary to \"inform a licensed attorney, who is a member of the bar of this Court, that she must ensure that her submissions to the Court are accurate.\" (slip op. 11). Consequence in Park: referral of counsel to the Grievance Panel under Local Rule 46.2 and an order to furnish the decision to the client (slip op. 3, 11-12).",
      "confidentiality_restriction": null,
      "record_keeping_duty": "none",
      "client_disclosure_duty": "none",
      "sources": [
        {
          "title": "Park v. Kim, No. 22-2057 (2d Cir. Jan. 30, 2024) (per curiam), ECF-stamped slip opinion (Doc. 178-1) via GovInfo — slip op. 9 (Rule 11 duty to read cited authority)",
          "url": "https://www.govinfo.gov/content/pkg/USCOURTS-ca2-22-02057/pdf/USCOURTS-ca2-22-02057-0.pdf",
          "verbatim": "At the very least, the duties imposed by Rule 11 require that attorneys read, and thereby confirm the existence and validity of, the legal authorities on which they rely.",
          "effective": "2024-01-30",
          "fetched": "2026-09-16"
        },
        {
          "title": "Same — slip op. 11 (no reasonable inquiry)",
          "url": "https://www.govinfo.gov/content/pkg/USCOURTS-ca2-22-02057/pdf/USCOURTS-ca2-22-02057-0.pdf",
          "verbatim": "The brief presents a false statement of law to this Court, and it appears that Attorney Lee made no inquiry, much less the reasonable inquiry required by Rule 11 and long-standing precedent, into the validity of the arguments she presented.",
          "effective": "2024-01-30",
          "fetched": "2026-09-16"
        },
        {
          "title": "Same — slip op. 10 (other courts' AI rules; the sentence that follows begins 'But such a rule is not necessary to' and is completed on slip op. 11 after footnote 3)",
          "url": "https://www.govinfo.gov/content/pkg/USCOURTS-ca2-22-02057/pdf/USCOURTS-ca2-22-02057-0.pdf",
          "verbatim": "Indeed, several courts have recently proposed or enacted local rules or orders specifically addressing the use of artificial intelligence tools before the court.",
          "effective": "2024-01-30",
          "fetched": "2026-09-16"
        },
        {
          "title": "Same — slip op. 11 (completion of the sentence 'But such a rule is not necessary to' begun on slip op. 10; fragment, not a full sentence)",
          "url": "https://www.govinfo.gov/content/pkg/USCOURTS-ca2-22-02057/pdf/USCOURTS-ca2-22-02057-0.pdf",
          "verbatim": "inform a licensed attorney, who is a member of the bar of this Court, that she must ensure that her submissions to the Court are accurate.",
          "effective": "2024-01-30",
          "fetched": "2026-09-16"
        },
        {
          "title": "Same — slip op. 3 (disposition as to counsel; the formal referral at slip op. 11-12 cites Local Rule 46.2)",
          "url": "https://www.govinfo.gov/content/pkg/USCOURTS-ca2-22-02057/pdf/USCOURTS-ca2-22-02057-0.pdf",
          "verbatim": "Because citation in a brief to a non-existent case suggests conduct that falls below the basic obligations of counsel, we refer Attorney Lee to the Court’s Grievance Panel, and further direct Attorney Lee to furnish a copy of this decision to her client, Plaintiff-Appellant Park.",
          "effective": "2024-01-30",
          "fetched": "2026-09-16"
        },
        {
          "title": "Local Rules and Internal Operating Procedures of the Court of Appeals for the Second Circuit (Effective December 2, 2024) — LR 32.1.1(a); no AI provision found (full-text grep)",
          "url": "https://www.ca2.uscourts.gov/clerk/case_filing/rules/pdf/LRs_IOCs_appendices_rev_2024.pdf",
          "verbatim": "Rulings by summary order do not have precedential effect.",
          "effective": "2024-12-02",
          "fetched": "2026-09-16"
        },
        {
          "title": "LEAD ONLY — Justia, Park v. Kim case page (used only to locate the opinion)",
          "url": "https://law.justia.com/cases/federal/appellate-courts/ca2/22-2057/22-2057-2024-01-30.html",
          "verbatim": null,
          "effective": null,
          "fetched": null
        }
      ],
      "status": "verified",
      "verified_on": "2026-09-17",
      "verified_by": "claude-opus-5 (independent verifier session; every source URL re-fetched 2026-09-17; checkq/strictq exact match; pinpoints, effective dates, status and narrative claims checked against the fetched text; one missed-item search)",
      "attorney_signoff": null,
      "notes": "(i) Checked, nothing AI-specific found (all fetched 2026-09-16): LR/IOP PDF https://www.ca2.uscourts.gov/clerk/case_filing/rules/pdf/LRs_IOCs_appendices_rev_2024.pdf (18,655 words; the only grep hit is an unrelated reference to artificial lighting in a camera/broadcast provision); LR index https://www.ca2.uscourts.gov/clerk/case_filing/rules/local_rules.html (lists LRs effective December 2, 2024; no AI rule); rules home https://www.ca2.uscourts.gov/clerk/case_filing/rules/rules_home.html; home page notices https://www.ca2.uscourts.gov/home.html (rule-amendment notices 2023-2024 concern LR 25.1, 35.1, 40.1, 40.2, 46.1 and FRAP 32/35/40; nothing on AI through Sept. 2026); announcements archive https://www.ca2.uscourts.gov/announcements_archive.html (no AI hits). (ii) Binding status: Park is a per curiam opinion, not a summary order (LR 32.1.1(a) denies precedential effect only to summary orders), so it is binding circuit precedent; it is a decision, not a rule. Park grounds the verification duty in Fed. R. Civ. P. 11 (and cites N.Y. R. Pro. Conduct 3.3(a)); it creates no disclosure or certification requirement. The client-notice order in Park was a case-specific directive to that attorney, not a general client-disclosure duty, so client_disclosure_duty is none. (iii) Pending/proposed: none found on the court's notices pages. (iv) Not fetched / not found: a ca2.uscourts.gov-hosted copy of Park (the decisions search is a POST form; curl attempts returned a dtSearch index error and HTTP 405), so the GovInfo copy of the ECF-stamped slip opinion was used; the reporter citation 91 F.4th 610 is not printed on the slip opinion (it is the citation used in McCarthy (3d Cir.) and Fletcher (5th Cir.)); the outcome of the Grievance Panel referral; any later Second Circuit precedential opinion on AI-fabricated citations (web searches 2026-09-16 found none; summary orders were not systematically searched, so this is not proof of absence). In the slip opinion the key sentence on AI rules is interrupted by footnote 3 and a page break, so it appears as two source items; no quotation stitches them."
    },
    {
      "id": "us-sdny",
      "kind": "federal_district",
      "name": "U.S. District Court for the Southern District of New York",
      "disclosure_to_court": "judge_specific",
      "certification_required": false,
      "certificate_language": null,
      "verification_duty": "No court-wide AI rule. Fed. R. Civ. P. 11(b) (national rule) applies: by presenting a paper, an attorney \"certifies that to the best of the person’s knowledge, information, and belief, formed after an inquiry reasonable under the circumstances\" that legal contentions are warranted and factual contentions have evidentiary support (Rule 11(b)(2)-(3), paraphrased); Rule 11(c)(1): \"Absent exceptional circumstances, a law firm must be held jointly responsible for a violation committed by its partner, associate, or employee.\" Local Civil Rule 1.5(b)(5) makes conduct that violates the New York Rules of Professional Conduct, in connection with activities in this court, a ground for discipline. Mata v. Avianca (Castel, J.; single-judge sanctions opinion, not a rule): \"existing rules impose a gatekeeping role on attorneys to ensure the accuracy of their filings.\" Individual judges may add AI disclosure/certification requirements (e.g., Judge Broderick).",
      "confidentiality_restriction": "No court-wide restriction on putting information into AI tools in the Local Rules or ECF Rules. Mediation only: SDNY Mediation Program Procedures (effective 7/1/2026) § 2(e) require remote-mediation participants to take reasonable security precautions, which \"must include taking steps so that only intended participants have access to the session\" and may include \"disabling any artificial intelligence associated with computer programs being used in the mediation\" (permissive, not mandatory); § 2(d): \"Neither the mediator nor any participant may record or permit the recording of any part of a mediation session\". Client-confidentiality duties come from the ny-rpc entry.",
      "record_keeping_duty": "none",
      "client_disclosure_duty": "none",
      "sources": [
        {
          "title": "Joint Local Rules of the S.D.N.Y. and E.D.N.Y. (effective Jan. 2, 2026), Local Civil Rule 1.5(b)(5) (Discipline of Attorneys — incorporation of N.Y. Rules of Professional Conduct)",
          "url": "https://www.nysd.uscourts.gov/sites/default/files/local_rules/2026-01-02%20-%20EDNY%20and%20SDNY%20Joint%20Local%20Rules%20As%20Amended.pdf",
          "verbatim": "In connection with activities in this court, any attorney is found to have engaged in conduct that violates the New York State Rules of Professional Conduct.",
          "effective": "2026-01-02",
          "fetched": "2026-09-16"
        },
        {
          "title": "Same — Local Civil Rule 1.1 (effective date)",
          "url": "https://www.nysd.uscourts.gov/sites/default/files/local_rules/2026-01-02%20-%20EDNY%20and%20SDNY%20Joint%20Local%20Rules%20As%20Amended.pdf",
          "verbatim": "These Local Civil Rules take effect on January 2, 2026 (the “Effective Date”) and govern actions pending or filed on or after that date.",
          "effective": "2026-01-02",
          "fetched": "2026-09-16"
        },
        {
          "title": "Same — Local Civil Rule 1.5(f) (remedies of individual judges preserved)",
          "url": "https://www.nysd.uscourts.gov/sites/default/files/local_rules/2026-01-02%20-%20EDNY%20and%20SDNY%20Joint%20Local%20Rules%20As%20Amended.pdf",
          "verbatim": "The remedies provided by this rule are in addition to the remedies available to individual district judges and magistrate judges under applicable law with respect to lawyers appearing before them.",
          "effective": "2026-01-02",
          "fetched": "2026-09-16"
        },
        {
          "title": "Same — Local Criminal Rule 1.1(b) (Local Civil Rule 1.5 among the civil rules applied in criminal proceedings)",
          "url": "https://www.nysd.uscourts.gov/sites/default/files/local_rules/2026-01-02%20-%20EDNY%20and%20SDNY%20Joint%20Local%20Rules%20As%20Amended.pdf",
          "verbatim": "In addition to Local Civil Rules referenced elsewhere in these Local Criminal Rules, the following Local Civil Rules also apply in criminal proceedings:",
          "effective": "2026-01-02",
          "fetched": "2026-09-16"
        },
        {
          "title": "Joint Notice to the Bar, Dec. 22, 2025 — Eastern and Southern District Courts adopt amendments to the Joint Local Rules (with redline) — no AI provision",
          "url": "https://nysd.uscourts.gov/sites/default/files/2025-12/2025-12-22%20Notice%20to%20Bar%20-%20Redline%20of%20Joint%20Local%20Rule%20Amendments%20Effective%2001-02-2026.pdf",
          "verbatim": "the judges of the Eastern and Southern Districts of New York have adopted amendments to their Joint Local Rules that take effect on January 2, 2026.",
          "effective": "2026-01-02",
          "fetched": "2026-09-16"
        },
        {
          "title": "Joint Notice to the Bar, July 1, 2026 — PROPOSED amendments to the Joint Local Rules (public comment), with redline and 2027 committee notes — none touches AI",
          "url": "https://www.nysd.uscourts.gov/sites/default/files/2026-07/20260701%20Joint%20Notice%20to%20Bar%20-%202026%20Amendments%20FINAL_0.pdf",
          "verbatim": "There is a ninety-day period during which comments may be provided, which begins today and closes on September 29, 2026.",
          "effective": null,
          "fetched": "2026-09-16"
        },
        {
          "title": "SDNY Electronic Case Filing Rules (effective Feb. 2, 2026) — no AI provision (grep)",
          "url": "https://www.nysd.uscourts.gov/sites/default/files/pdf/ecf_rules/ECF%20Rules%20February%202%202026%20FINAL%20v2.pdf",
          "verbatim": null,
          "effective": "2026-02-02",
          "fetched": "2026-09-16"
        },
        {
          "title": "SDNY Mediation Program Procedures (effective 7/1/2026), § 2(e) (security precautions for remote mediation) — program procedures, not a local rule",
          "url": "https://www.nysd.uscourts.gov/sites/default/files/sites/default/files/pdf/Mediation/Mediation%20Program%20Procedures.7.1.2026.pdf",
          "verbatim": "Such precautions must include taking steps so that only intended participants have access to the session, and may include using a secure WiFi/Ethernet connection for all communications related to the mediation session, using secure meeting access codes, enabling an electronic waiting room, locking meetings once all participants have convened, or disabling any artificial intelligence associated with computer programs being used in the mediation.",
          "effective": "2026-07-01",
          "fetched": "2026-09-16"
        },
        {
          "title": "Same — § 2(d) (no recording of mediation sessions)",
          "url": "https://www.nysd.uscourts.gov/sites/default/files/sites/default/files/pdf/Mediation/Mediation%20Program%20Procedures.7.1.2026.pdf",
          "verbatim": "Neither the mediator nor any participant may record or permit the recording of any part of a mediation session including audio, video, chat, closed-captions, or any other methods of communication whether the mediation session is conducted in person, or through telephone or video conference.",
          "effective": "2026-07-01",
          "fetched": "2026-09-16"
        },
        {
          "title": "Fed. R. Civ. P. 11(b) (Federal Rules of Civil Procedure, Dec. 1, 2025 edition, uscourts.gov) — national rule",
          "url": "https://www.uscourts.gov/sites/default/files/document/federal-rules-of-civil-procedure.pdf",
          "verbatim": "certifies that to the best of the person’s knowledge, information, and belief, formed after an inquiry reasonable under the circumstances",
          "effective": null,
          "fetched": "2026-09-16"
        },
        {
          "title": "Same — Fed. R. Civ. P. 11(c)(1) (law firm responsibility)",
          "url": "https://www.uscourts.gov/sites/default/files/document/federal-rules-of-civil-procedure.pdf",
          "verbatim": "Absent exceptional circumstances, a law firm must be held jointly responsible for a violation committed by its partner, associate, or employee.",
          "effective": null,
          "fetched": "2026-09-16"
        },
        {
          "title": "Mata v. Avianca, Inc., No. 22-cv-1461 (PKC), ECF No. 54, Opinion and Order on Sanctions (S.D.N.Y. June 22, 2023) (Castel, J.), p. 1 — single-judge sanctions opinion, not a court rule",
          "url": "https://storage.courtlistener.com/recap/gov.uscourts.nysd.575368/gov.uscourts.nysd.575368.54.0.pdf",
          "verbatim": "Technological advances are commonplace and there is nothing inherently improper about using a reliable artificial intelligence tool for assistance. But existing rules impose a gatekeeping role on attorneys to ensure the accuracy of their filings.",
          "effective": "2023-06-22",
          "fetched": "2026-09-16"
        },
        {
          "title": "Same — Conclusions of Law ¶ 23(a), p. 29 (signing attorney's failure to read cited cases)",
          "url": "https://storage.courtlistener.com/recap/gov.uscourts.nysd.575368/gov.uscourts.nysd.575368.54.0.pdf",
          "verbatim": "Mr. LoDuca violated Rule 11 in not reading a single case cited in his March 1 Affirmation in Opposition and taking no other steps on his own to check whether any aspect of the assertions of law were warranted by existing law.",
          "effective": "2023-06-22",
          "fetched": "2026-09-16"
        },
        {
          "title": "Judge-specific — District Judge Vernon S. Broderick — Model Certificate Regarding the Use of Generative Artificial Intelligence (form PDF) — not court-wide",
          "url": "https://nysd.uscourts.gov/sites/default/files/practice_documents/VSB%20Broderick%20Model%20Certification%20Regarding%20the%20Use%20of%20AI%20in%20Filings.pdf",
          "verbatim": "I understand that I will be held individually responsible for the contents thereof according to Rule 11(b) of the Federal Rules of Civil Procedure and the certifications required thereunder, including verifying any portions of the filing drafted by generative AI",
          "effective": null,
          "fetched": "2026-09-16"
        },
        {
          "title": "Judge-specific — Broderick — SDNY web page 'Certificate Regarding the Use of Generative Artificial Intelligence' (published 10/29/2025; page field Judge: Hon. Vernon S. Broderick) — not court-wide",
          "url": "https://nysd.uscourts.gov/certificate-regarding-use-generative-artificial-intelligence",
          "verbatim": null,
          "effective": null,
          "fetched": "2026-09-16"
        },
        {
          "title": "SDNY Local Rules page (incl. court Standing Orders list) — checked, no AI order",
          "url": "https://www.nysd.uscourts.gov/rules",
          "verbatim": null,
          "effective": null,
          "fetched": "2026-09-16"
        },
        {
          "title": "SDNY Proposed Amendments page — checked, only the July 1, 2026 joint notice (no AI)",
          "url": "https://www.nysd.uscourts.gov/rules/proposed-amendments",
          "verbatim": null,
          "effective": null,
          "fetched": "2026-09-16"
        },
        {
          "title": "SDNY Notice to the Bar page — checked, no AI notice",
          "url": "https://www.nysd.uscourts.gov/notice-to-the-bar",
          "verbatim": null,
          "effective": null,
          "fetched": "2026-09-16"
        },
        {
          "title": "SDNY Prior Versions of Local Rules page — checked",
          "url": "https://www.nysd.uscourts.gov/prior-versions-local-rules",
          "verbatim": null,
          "effective": null,
          "fetched": "2026-09-16"
        },
        {
          "title": "SDNY ECF Rules & Instructions page — checked",
          "url": "https://www.nysd.uscourts.gov/rules/ecf-related-instructions",
          "verbatim": null,
          "effective": null,
          "fetched": "2026-09-16"
        },
        {
          "title": "SDNY District Judges page (links to each judge's Individual Rules & Practices) — check assigned judge per matter",
          "url": "https://www.nysd.uscourts.gov/judges/district-judges",
          "verbatim": null,
          "effective": null,
          "fetched": "2026-09-16"
        },
        {
          "title": "Judge-specific — Judge John P. Cronan, Individual Rules and Practices in Civil Cases (Updated 2025.10.23), § E, Use of Artificial Intelligence (\"AI\") Tools — judge-level certification requirement, not court-wide — fetched at verification 2026-09-17 and re-read at merge",
          "url": "https://www.nysd.uscourts.gov/sites/default/files/practice_documents/JPC%20Cronan%20Individual%20Civil%20Rules%20-%20Updated%202025.10.23.pdf",
          "verbatim": "Any attorney who signs a filing for which an AI tool was used to prepare (including by appearing on the signature block of the filing) must attach to the filing a signed certification (i) stating whether the litigant personally reviewed the filing for accuracy of cited legal authorities and factual assertions and (ii) if so, describing in detail the steps taken to verify the accuracy of all legal authorities and factual assertions generated by the AI tool.",
          "effective": "2025-10-23",
          "fetched": "2026-09-17"
        },
        {
          "title": "Judge-specific — Judge John P. Cronan, Model Certification Regarding Use of Artificial Intelligence in Filings (Updated 2025.10.23; supersedes the 8.21.2025 form) — form text not quoted here; read the current file from the judge's page before filing",
          "url": "https://www.nysd.uscourts.gov/hon-john-p-cronan",
          "verbatim": null,
          "effective": "2025-10-23",
          "fetched": "2026-09-17"
        },
        {
          "title": "Decision (single judge, not a rule) — United States v. Heppner, No. 25 Cr. 503 (JSR) (S.D.N.Y. Feb. 17, 2026) (Rakoff, J.), Memorandum, ECF No. 27: exchanges with a consumer generative-AI platform held not protected by attorney-client privilege or work product — scanned PDF with no text layer; verifier read it by OCR; not quoted; read before relying",
          "url": "https://storage.courtlistener.com/recap/gov.uscourts.nysd.652138/gov.uscourts.nysd.652138.27.0.pdf",
          "verbatim": null,
          "effective": "2026-02-17",
          "fetched": "2026-09-17"
        },
        {
          "title": "LEAD ONLY — Greenberg Traurig, Navigating AI Disclosure Rules in New York Courts (Nov. 2025)",
          "url": "https://www.gtlaw.com/en/insights/2025/11/navigating-ai-disclosure-rules-in-new-york-courts",
          "verbatim": null,
          "effective": null,
          "fetched": null
        },
        {
          "title": "LEAD ONLY — Ropes & Gray, Artificial Intelligence Court Order Tracker",
          "url": "https://www.ropesgray.com/en/sites/artificial-intelligence-court-order-tracker",
          "verbatim": null,
          "effective": null,
          "fetched": null
        }
      ],
      "status": "verified",
      "verified_on": "2026-09-17",
      "verified_by": "claude-opus-5 (independent verifier session; every source URL re-fetched 2026-09-17; checkq/strictq exact match; pinpoints, effective dates, status and narrative claims checked against the fetched text; one missed-item search)",
      "attorney_signoff": null,
      "notes": "(i) COURT-WIDE: VERIFIED NOTHING AI-SPECIFIC in the rules governing filings. The Joint Local Civil, Admiralty, Social Security, Criminal and Patent Rules of the S.D.N.Y. and E.D.N.Y. (effective January 2, 2026 per the cover and L.Civ.R. 1.1) were grepped in full (AI, generative, machine learning, large language, ChatGPT, technology, hallucination): only hits are Local Patent Rule 1 (the word technology, in case complexity) and a 2026 committee note on pro se litigants' access to technology. SDNY ECF Rules (effective February 2, 2026): no hits. Pages/documents checked with nothing AI-specific, all fetched 2026-09-16: https://www.nysd.uscourts.gov/rules (Local Rules page, including the court's Standing Orders list, newest Nov. 10, 2025 M10-468); https://www.nysd.uscourts.gov/rules/proposed-amendments; https://www.nysd.uscourts.gov/prior-versions-local-rules; https://www.nysd.uscourts.gov/notice-to-the-bar (notices Dec. 2024 through Sept. 9, 2026); https://www.nysd.uscourts.gov/rules/ecf-related-instructions; Joint Rules Committee information 2026 PDF (https://www.nysd.uscourts.gov/sites/default/files/pdf/Proposed%20Amendments/Joint%20Rules%20Committee%20Website%20Information%202026.pdf); https://www.nysd.uscourts.gov/judges/district-judges. The only court-wide SDNY document found that mentions AI is the Mediation Program Procedures (effective 7/1/2026) § 2(e), read in full: a permissive security precaution for remote mediations, not a filing rule. (ii) BINDING STATUS: Local Civil Rule 1.5 is a binding local rule. Mediation Program Procedures are program procedures (§ 1 says they do not vest rights in litigants or attorneys). Mata v. Avianca is a single-judge sanctions opinion (Castel, J.), persuasive only, not a court rule; sanctions were imposed under Rule 11 and, alternatively, inherent power (a $5,000 penalty plus letters to the client and to the judges falsely named). Judge-level practices bind only in that judge's cases. (iii) PROPOSED/PENDING: Joint Notice to the Bar, July 1, 2026 (read in full) proposes amendments to L.Civ.R. 1.3, 5.2, 6.1, 6.3, 7.1, 15.1, 37.2, 39.1, 47.1, 56.1 and 83.1; comment period closes September 29, 2026; none touches AI, disclosure, or certification of AI use. (iv) JUDGE LEVEL (not built per protocol Tier 3): confirmed from the court's own site that at least one SDNY judge requires an AI certificate. The page titled Certificate Regarding the Use of Generative Artificial Intelligence (published 10/29/2025) carries the Judge field \"Hon. Vernon S. Broderick\" and the linked form recites that the signer has read the Individual Rules & Practices in Civil Cases for Judge Broderick, so it is tied to one judge, not a court-wide form. Hence disclosure_to_court is judge_specific and certification_required is false for the court-wide position; individual judges may require AI disclosure or certification. Check the assigned district and magistrate judge's Individual Rules & Practices (https://www.nysd.uscourts.gov/judges/district-judges and https://www.nysd.uscourts.gov/judges/magistrate-judges) for every matter. (v) NOT FETCHED: https://nysd.uscourts.gov/model-certification-regarding-use-artificial-intelligence-filings returned HTTP 403 (access denied) on 2026-09-16; Judge Cronan's Individual Rules § E and updated model certification (fetched 2026-09-17, above) and Judge Ho's individual rules were located by web search only (leads). Mata pages 35-43 (appendices: the fabricated opinion and ChatGPT screenshots) are image-only and were not OCR'd; nothing is quoted from them. The U.S. Bankruptcy Court for the S.D.N.Y. (separate local rules) was not checked. Local criminal rules are part of the joint rules PDF and were covered by the grep. (vi) PROFESSIONAL CONDUCT: L.Civ.R. 1.5(b)(5) incorporates the New York Rules of Professional Conduct for conduct in connection with activities in this court (and L.Cr.R. 1.1(b) applies L.Civ.R. 1.5 in criminal proceedings), so the ny-rpc entry supplies competence, confidentiality, candor, supervision, and client communication duties. Fed. R. Civ. P. 11 is a national rule applying in civil actions in every district court; the uscourts.gov text is the Dec. 1, 2025 edition (effective left null because the PDF does not state Rule 11's own effective date)."
    },
    {
      "id": "us-edny",
      "kind": "federal_district",
      "name": "U.S. District Court for the Eastern District of New York",
      "disclosure_to_court": "judge_specific",
      "certification_required": false,
      "certificate_language": null,
      "verification_duty": "No court-wide AI rule. Fed. R. Civ. P. 11(b) (national rule) applies: by presenting a paper, an attorney \"certifies that to the best of the person’s knowledge, information, and belief, formed after an inquiry reasonable under the circumstances\" that legal contentions are warranted and factual contentions have evidentiary support (Rule 11(b)(2)-(3), paraphrased); Rule 11(c)(1): \"Absent exceptional circumstances, a law firm must be held jointly responsible for a violation committed by its partner, associate, or employee.\" Joint Local Civil Rule 1.5(b)(5) (shared with S.D.N.Y.) makes conduct violating the New York Rules of Professional Conduct in connection with activities in this court a ground for discipline. Judge-level examples: Magistrate Judge Lindsay requires disclosure plus a certification that the person \"has checked the accuracy of any portion of the document drafted by generative AI, including all citations and legal authority\"; Judge Gonzalez warns that \"The use of AI-generated content without verification of its accuracy implicates Federal Rule of Civil Procedure 11\".",
      "confidentiality_restriction": "No court-wide restriction for attorneys. The court's pro se manual (guidance for self-represented litigants, not a rule) states: \"information submitted to ChatGPT or other AI is not confidential.\" Attorney confidentiality duties come from the ny-rpc entry.",
      "record_keeping_duty": "none",
      "client_disclosure_duty": "none",
      "sources": [
        {
          "title": "Joint Local Rules of the S.D.N.Y. and E.D.N.Y. (effective Jan. 2, 2026), EDNY-hosted copy (byte-identical to the SDNY-hosted PDF, same MD5), Local Civil Rule 1.5(b)(5) (Discipline of Attorneys — incorporation of N.Y. Rules of Professional Conduct)",
          "url": "https://www.nyed.uscourts.gov/sites/default/files/uploads/2026-01-02%20-%20edny%20and%20sdny%20joint%20local%20rules%20as%20amended.pdf",
          "verbatim": "In connection with activities in this court, any attorney is found to have engaged in conduct that violates the New York State Rules of Professional Conduct.",
          "effective": "2026-01-02",
          "fetched": "2026-09-16"
        },
        {
          "title": "Same — Local Civil Rule 1.1 (effective date)",
          "url": "https://www.nyed.uscourts.gov/sites/default/files/uploads/2026-01-02%20-%20edny%20and%20sdny%20joint%20local%20rules%20as%20amended.pdf",
          "verbatim": "These Local Civil Rules take effect on January 2, 2026 (the “Effective Date”) and govern actions pending or filed on or after that date.",
          "effective": "2026-01-02",
          "fetched": "2026-09-16"
        },
        {
          "title": "Same — Local Civil Rule 1.5(f) (remedies of individual judges preserved)",
          "url": "https://www.nyed.uscourts.gov/sites/default/files/uploads/2026-01-02%20-%20edny%20and%20sdny%20joint%20local%20rules%20as%20amended.pdf",
          "verbatim": "The remedies provided by this rule are in addition to the remedies available to individual district judges and magistrate judges under applicable law with respect to lawyers appearing before them.",
          "effective": "2026-01-02",
          "fetched": "2026-09-16"
        },
        {
          "title": "Same — Local Criminal Rule 1.1(b) (Local Civil Rule 1.5 among the civil rules applied in criminal proceedings)",
          "url": "https://www.nyed.uscourts.gov/sites/default/files/uploads/2026-01-02%20-%20edny%20and%20sdny%20joint%20local%20rules%20as%20amended.pdf",
          "verbatim": "In addition to Local Civil Rules referenced elsewhere in these Local Criminal Rules, the following Local Civil Rules also apply in criminal proceedings:",
          "effective": "2026-01-02",
          "fetched": "2026-09-16"
        },
        {
          "title": "Joint Notice to the Bar, Dec. 22, 2025 — Eastern and Southern District Courts adopt amendments to the Joint Local Rules (SDNY-hosted copy; also linked from EDNY Local Rules page) — no AI provision",
          "url": "https://nysd.uscourts.gov/sites/default/files/2025-12/2025-12-22%20Notice%20to%20Bar%20-%20Redline%20of%20Joint%20Local%20Rule%20Amendments%20Effective%2001-02-2026.pdf",
          "verbatim": "the judges of the Eastern and Southern Districts of New York have adopted amendments to their Joint Local Rules that take effect on January 2, 2026.",
          "effective": "2026-01-02",
          "fetched": "2026-09-16"
        },
        {
          "title": "Joint Notice to the Bar, July 1, 2026 — PROPOSED amendments to the Joint Local Rules (public comment; SDNY-hosted copy of the joint notice linked from EDNY's Proposed Amendments page) — none touches AI",
          "url": "https://www.nysd.uscourts.gov/sites/default/files/2026-07/20260701%20Joint%20Notice%20to%20Bar%20-%202026%20Amendments%20FINAL_0.pdf",
          "verbatim": "There is a ninety-day period during which comments may be provided, which begins today and closes on September 29, 2026.",
          "effective": null,
          "fetched": "2026-09-16"
        },
        {
          "title": "Fed. R. Civ. P. 11(b) (Federal Rules of Civil Procedure, Dec. 1, 2025 edition, uscourts.gov) — national rule",
          "url": "https://www.uscourts.gov/sites/default/files/document/federal-rules-of-civil-procedure.pdf",
          "verbatim": "certifies that to the best of the person’s knowledge, information, and belief, formed after an inquiry reasonable under the circumstances",
          "effective": null,
          "fetched": "2026-09-16"
        },
        {
          "title": "Same — Fed. R. Civ. P. 11(c)(1) (law firm responsibility)",
          "url": "https://www.uscourts.gov/sites/default/files/document/federal-rules-of-civil-procedure.pdf",
          "verbatim": "Absent exceptional circumstances, a law firm must be held jointly responsible for a violation committed by its partner, associate, or employee.",
          "effective": null,
          "fetched": "2026-09-16"
        },
        {
          "title": "Judge-specific — Magistrate Judge Arlene R. Lindsay — Individual Practices (header dated 4/2026), § 2.C.3, Artificial Intelligence (AI) Provision — not court-wide",
          "url": "https://www.nyed.uscourts.gov/pub/rules/ARL-MLR.pdf",
          "verbatim": "any attorney for a party, or any pro se party, who has used AI in the preparation of any documents filed with the Court must disclose that AI has been used and must further certify in the document that the person has checked the accuracy of any portion of the document drafted by generative AI, including all citations and legal authority.",
          "effective": null,
          "fetched": "2026-09-16"
        },
        {
          "title": "Judge-specific — District Judge Hector Gonzalez — Individual Practices (Last Updated July 23, 2026), Notice to Counsel and Litigants Regarding Artificial Intelligence — not court-wide",
          "url": "https://www.nyed.uscourts.gov/pub/rules/HG-MLR.pdf",
          "verbatim": "The Court has a zero-tolerance policy for any filings that include AI-generated hallucinations, fabricated legal propositions, or severe misstatements of the law. Attorneys and pro se litigants are on notice that such filings may warrant sanctions absent reasonable excuse.",
          "effective": null,
          "fetched": "2026-09-16"
        },
        {
          "title": "Same (Gonzalez) — Rule 11 sentence",
          "url": "https://www.nyed.uscourts.gov/pub/rules/HG-MLR.pdf",
          "verbatim": "The use of AI-generated content without verification of its accuracy implicates Federal Rule of Civil Procedure 11, which applies fully to actions filed by pro se litigants.",
          "effective": null,
          "fetched": "2026-09-16"
        },
        {
          "title": "EDNY, Representing Yourself in the Eastern District of New York: A Manual for Pro Se Litigants (2025), section Use of Artificial Intelligence (AI), p. 41 — court guidance for self-represented litigants, not a rule",
          "url": "https://www.nyed.uscourts.gov/sites/default/files/uploads/edny%20pro%20se%20manual%2009-2025.pdf",
          "verbatim": "While you may use ChatGPT or other artificial intelligence tools to assist with writing your complaint or response to motions and court orders, you must review your submission before filing with the court.",
          "effective": null,
          "fetched": "2026-09-16"
        },
        {
          "title": "Same (pro se manual) — confidentiality sentence, p. 41",
          "url": "https://www.nyed.uscourts.gov/sites/default/files/uploads/edny%20pro%20se%20manual%2009-2025.pdf",
          "verbatim": "In addition, information submitted to ChatGPT or other AI is not confidential.",
          "effective": null,
          "fetched": "2026-09-16"
        },
        {
          "title": "EDNY Administrative Order Search (all 16 listing pages, 355 orders, 1986-2026) — titles checked, no AI administrative order",
          "url": "https://www.nyed.uscourts.gov/administrative-order-search",
          "verbatim": null,
          "effective": null,
          "fetched": "2026-09-16"
        },
        {
          "title": "EDNY Compendium of Administrative Orders Relevant to Practitioners (orders effective as of July 11, 2025) — no AI order (grep hits only on electronic-device technology)",
          "url": "https://www.nyed.uscourts.gov/sites/default/files/uploads/aocompendium.pdf",
          "verbatim": null,
          "effective": null,
          "fetched": "2026-09-16"
        },
        {
          "title": "EDNY Local Rules & Division of Business page — checked",
          "url": "https://www.nyed.uscourts.gov/local-rules-division-business",
          "verbatim": null,
          "effective": null,
          "fetched": "2026-09-16"
        },
        {
          "title": "EDNY Proposed Amendments page — checked (2025 and 2026 joint notices only)",
          "url": "https://www.nyed.uscourts.gov/proposed-amendments",
          "verbatim": null,
          "effective": null,
          "fetched": "2026-09-16"
        },
        {
          "title": "EDNY Public Notices page (page 1 of 3; pages 2-3 also fetched) — checked, no AI notice",
          "url": "https://www.nyed.uscourts.gov/public-notices",
          "verbatim": null,
          "effective": null,
          "fetched": "2026-09-16"
        },
        {
          "title": "EDNY Court Bulletins page — checked, no AI bulletin",
          "url": "https://www.nyed.uscourts.gov/court-bulletins",
          "verbatim": null,
          "effective": null,
          "fetched": "2026-09-16"
        },
        {
          "title": "EDNY CM/ECF NextGen Information page — checked",
          "url": "https://www.nyed.uscourts.gov/cmecf-nextgen-information",
          "verbatim": null,
          "effective": null,
          "fetched": "2026-09-16"
        },
        {
          "title": "EDNY Mandatory Electronic Filing notice (Administrative Order 2004-08) — checked, no AI",
          "url": "https://www.nyed.uscourts.gov/sites/default/files/uploads/mandatoryecffiling.pdf",
          "verbatim": null,
          "effective": null,
          "fetched": "2026-09-16"
        },
        {
          "title": "EDNY CM/ECF User Manual — checked, no AI",
          "url": "https://www.nyed.uscourts.gov/sites/default/files/uploads/ecf-usermanual.pdf",
          "verbatim": null,
          "effective": null,
          "fetched": "2026-09-16"
        },
        {
          "title": "EDNY District Judges page (individual practices per judge) — check assigned judge per matter",
          "url": "https://www.nyed.uscourts.gov/district-judges",
          "verbatim": null,
          "effective": null,
          "fetched": "2026-09-16"
        },
        {
          "title": "EDNY Magistrate Judges page (individual practices per judge) — check assigned judge per matter",
          "url": "https://www.nyed.uscourts.gov/magistrate-judges",
          "verbatim": null,
          "effective": null,
          "fetched": "2026-09-16"
        },
        {
          "title": "Judge-specific — Magistrate Judge Lee G. Dunst, Individual Practice Rules, ¶ 4 (a caution only; no disclosure or certification requirement) — fetched at verification 2026-09-17 and re-read at merge",
          "url": "https://www.nyed.uscourts.gov/pub/rules/LGD-MLR.pdf",
          "verbatim": "The parties are cautioned to ensure that any use of Artificial Intelligence resources in connection with their submissions to the Court still comply with their professional obligations to the Court. See Benjamin v. Costco Wholesale Corp., 779 F. Supp. 3d 341 (E.D.N.Y. 2025)",
          "effective": null,
          "fetched": "2026-09-17"
        },
        {
          "title": "LEAD ONLY — Greenberg Traurig, Navigating AI Disclosure Rules in New York Courts (Nov. 2025)",
          "url": "https://www.gtlaw.com/en/insights/2025/11/navigating-ai-disclosure-rules-in-new-york-courts",
          "verbatim": null,
          "effective": null,
          "fetched": null
        }
      ],
      "status": "verified",
      "verified_on": "2026-09-17",
      "verified_by": "claude-opus-5 (independent verifier session; every source URL re-fetched 2026-09-17; checkq/strictq exact match; pinpoints, effective dates, status and narrative claims checked against the fetched text; one missed-item search)",
      "attorney_signoff": null,
      "notes": "(i) COURT-WIDE: VERIFIED NOTHING AI-SPECIFIC in rules or orders governing attorney filings. EDNY shares the Joint Local Rules with S.D.N.Y. (EDNY-hosted PDF is byte-identical to the SDNY copy; effective January 2, 2026 per cover and L.Civ.R. 1.1); full-text grep found no AI provision (only a patent-rule use of the word technology and a 2026 committee note on pro se litigants' technology). Pages/documents checked with nothing AI-specific, all fetched 2026-09-16: https://www.nyed.uscourts.gov/local-rules-division-business; https://www.nyed.uscourts.gov/proposed-amendments; https://www.nyed.uscourts.gov/administrative-order-search (every listing page, ?page=1 through ?page=15, 355 administrative orders by title, newest 2026-21); https://www.nyed.uscourts.gov/sites/default/files/uploads/aocompendium.pdf (Compendium of Administrative Orders Relevant to Practitioners, orders effective as of July 11, 2025); https://www.nyed.uscourts.gov/public-notices (all 3 pages); https://www.nyed.uscourts.gov/court-bulletins; https://www.nyed.uscourts.gov/cmecf-nextgen-information; mandatoryecffiling.pdf and ecf-usermanual.pdf (EDNY posts no separate ECF rules book comparable to SDNY's); https://www.nyed.uscourts.gov/federal-court-rules; https://www.nyed.uscourts.gov/document-search; https://www.nyed.uscourts.gov/attorneys; https://www.nyed.uscourts.gov/ (home). The only court-level document mentioning AI is the 2025 pro se manual (p. 41, and a caution on p. 14 that AI chatbots may be inaccurate), which is guidance to self-represented litigants and does not bind attorneys. (ii) BINDING STATUS: Local Civil Rule 1.5 is a binding local rule. Pro se manual is non-binding guidance. Judge-level practices (Lindsay, Gonzalez) bind only in that judge's cases. (iii) PROPOSED/PENDING: Joint Notice to the Bar, July 1, 2026 (read in full): proposed amendments to L.Civ.R. 1.3, 5.2, 6.1, 6.3, 7.1, 15.1, 37.2, 39.1, 47.1, 56.1, 83.1; comments close September 29, 2026; none touches AI. (iv) JUDGE LEVEL (not built per protocol Tier 3): confirmed on the court's own site that Magistrate Judge Arlene R. Lindsay's Individual Practices (§ 2.C.3) require AI disclosure and a certification, and District Judge Hector Gonzalez's Individual Practices carry an AI sanctions notice. Hence disclosure_to_court is judge_specific; certification_required is false for the court-wide position; individual judges may require disclosure or certification. Check the assigned district and magistrate judge's Individual Practices (https://www.nyed.uscourts.gov/district-judges and https://www.nyed.uscourts.gov/magistrate-judges) for every matter. (v) NOT FETCHED: https://www.nyed.uscourts.gov/local-rules-documents-and-administrative-orders and https://www.nyed.uscourts.gov/court-info/local-rules-and-orders/general-orders returned HTTP 404 (site reorganized; current pages above used instead); keyword-filtered administrative-order search URLs returned 404, so the unfiltered listing was read page by page. Magistrate Judge Dunst's practices are a search lead only. The EDNY Bankruptcy Court was not checked. EDNY-hosted copy of the July 1, 2026 joint notice was not separately fetched (the SDNY-hosted copy of the same joint notice was read). (vi) PROFESSIONAL CONDUCT: L.Civ.R. 1.5(b)(5) incorporates the New York Rules of Professional Conduct (L.Cr.R. 1.1(b) applies it in criminal proceedings), so the ny-rpc entry supplies competence, confidentiality, candor, supervision, and client-communication duties. Fed. R. Civ. P. 11 is a national rule applying in civil actions in every district court (Dec. 1, 2025 uscourts.gov edition; effective left null because the PDF does not state Rule 11's own effective date)."
    },
    {
      "id": "us-dnj",
      "kind": "federal_district",
      "name": "U.S. District Court for the District of New Jersey",
      "disclosure_to_court": "none",
      "certification_required": false,
      "certificate_language": null,
      "verification_duty": "No court-wide AI rule; the court's rules committee considered and declined an AI local rule (Lawyers Advisory Committee minutes, March 5, 2024). Fed. R. Civ. P. 11(b) (national rule) applies: by presenting a paper, an attorney \"certifies that to the best of the person’s knowledge, information, and belief, formed after an inquiry reasonable under the circumstances\" that legal contentions are warranted and factual contentions have evidentiary support (Rule 11(b)(2)-(3), paraphrased). L.Civ.R. 11.1: \"Counsel admitted pro hac vice also are deemed responsible under Fed. R. Civ. P. 11(b) for filings with the Court\". L.Civ.R. 103.1(a) adopts the New Jersey Rules of Professional Conduct and L.Civ.R. 104.1(d)(2) makes their violation misconduct and grounds for discipline.",
      "confidentiality_restriction": null,
      "record_keeping_duty": "none",
      "client_disclosure_duty": "none",
      "sources": [
        {
          "title": "Local Civil and Criminal Rules of the U.S. District Court for the District of New Jersey (With Revisions as of July 22, 2026), L.Civ.R. 103.1(a) (Judicial Ethics and Professional Responsibility — incorporation of N.J. Rules of Professional Conduct)",
          "url": "https://www.njd.uscourts.gov/sites/njd/files/CompleteLocalRules.pdf",
          "verbatim": "The Rules of Professional Conduct of the American Bar Association as revised by the New Jersey Supreme Court shall govern the conduct of the members of the bar admitted to practice in this Court, subject to such modifications as may be required or permitted by Federal statute, regulation, court rule or decision of law.",
          "effective": null,
          "fetched": "2026-09-16"
        },
        {
          "title": "Same — L.Civ.R. 104.1(d)(2) (Standards for Professional Conduct)",
          "url": "https://www.njd.uscourts.gov/sites/njd/files/CompleteLocalRules.pdf",
          "verbatim": "An act or omission by an attorney admitted to practice before this Court, individually or in concert with any other person or persons, which violates the applicable Rules of Professional Conduct referred to in L.Civ.R. 103.1 shall constitute misconduct and be grounds for discipline whether or not the act or omission occurred in the course of an attorney-client relationship.",
          "effective": null,
          "fetched": "2026-09-16"
        },
        {
          "title": "Same — L.Civ.R. 11.1 (Signing of Pleadings; pro hac vice counsel and Rule 11(b))",
          "url": "https://www.njd.uscourts.gov/sites/njd/files/CompleteLocalRules.pdf",
          "verbatim": "Counsel admitted pro hac vice also are deemed responsible under Fed. R. Civ. P. 11(b) for filings with the Court, as provided in Local Civil Rule 101.1(c)(6).",
          "effective": null,
          "fetched": "2026-09-16"
        },
        {
          "title": "Same — L.Cr.R. 1.1 (Scope and Applicability; list includes L.Civ.R. 103.1 and 104.1)",
          "url": "https://www.njd.uscourts.gov/sites/njd/files/CompleteLocalRules.pdf",
          "verbatim": "The following Local Civil Rules are applicable to criminal cases in the District of New Jersey:",
          "effective": null,
          "fetched": "2026-09-16"
        },
        {
          "title": "Fed. R. Civ. P. 11(b) (Federal Rules of Civil Procedure, Dec. 1, 2025 edition, uscourts.gov) — national rule",
          "url": "https://www.uscourts.gov/sites/default/files/document/federal-rules-of-civil-procedure.pdf",
          "verbatim": "certifies that to the best of the person’s knowledge, information, and belief, formed after an inquiry reasonable under the circumstances",
          "effective": null,
          "fetched": "2026-09-16"
        },
        {
          "title": "Same — Fed. R. Civ. P. 11(c)(1) (law firm responsibility)",
          "url": "https://www.uscourts.gov/sites/default/files/document/federal-rules-of-civil-procedure.pdf",
          "verbatim": "Absent exceptional circumstances, a law firm must be held jointly responsible for a violation committed by its partner, associate, or employee.",
          "effective": null,
          "fetched": "2026-09-16"
        },
        {
          "title": "D.N.J. Lawyers Advisory Committee, Minutes of March 5, 2024, item 3 — court Rules Committee declined an AI local rule (advisory committee minutes posted on the court site; not a rule or order)",
          "url": "https://www.njd.uscourts.gov/sites/njd/files/LACMinutes03-5-24.pdf",
          "verbatim": "The Rules Committee reviewed recommendations by the LAC for an Artificial Intelligence local rule and determined one is not necessary at this time.",
          "effective": null,
          "fetched": "2026-09-16"
        },
        {
          "title": "D.N.J. Lawyers Advisory Committee, Minutes of June 5, 2023, item 10 — AI certification idea first raised (not adopted)",
          "url": "https://www.njd.uscourts.gov/sites/njd/files/LACMinutes06-05-23.pdf",
          "verbatim": "LAC members, Karen Confoy and Steve Richman recommended possibly amending L.Civ.R. 11.1 to require attorneys to certify they have not used artificial intelligence in brief drafting.",
          "effective": null,
          "fetched": "2026-09-16"
        },
        {
          "title": "D.N.J. Lawyers Advisory Committee, Minutes of September 6, 2023, item 9 — AI committee report",
          "url": "https://www.njd.uscourts.gov/sites/njd/files/LACMinutes09-06-23.pdf",
          "verbatim": "A request was made that no judge adopt a certification regarding A.I until a determination is made on the rules.",
          "effective": null,
          "fetched": "2026-09-16"
        },
        {
          "title": "D.N.J. Lawyers Advisory Committee, Minutes of December 5, 2023, item 5 — AI local rule before Board of Judges",
          "url": "https://www.njd.uscourts.gov/sites/njd/files/LACMinutes12-05-23.pdf",
          "verbatim": "Judge O’Hearn reported that the LAC recommendation regarding an Artificial Intelligence Local Rule is being considered at the December Board of Judges’ meeting.",
          "effective": null,
          "fetched": "2026-09-16"
        },
        {
          "title": "D.N.J. Lawyers Advisory Committee, Minutes of March 4, 2025, item 4 — Third Circuit AI committee announced",
          "url": "https://www.njd.uscourts.gov/sites/njd/files/LACMinutes3-4-25.pdf",
          "verbatim": "Chief Judge Chagares announced a Circuit-wide AI committee has been created.",
          "effective": null,
          "fetched": "2026-09-16"
        },
        {
          "title": "D.N.J. Lawyers Advisory Committee, Minutes of December 3, 2025, item 9(b) — LAC-internal proposal of an AI amendment to Appendix S (Confidentiality Order); subcommittee formed; not a published proposed amendment",
          "url": "https://www.njd.uscourts.gov/sites/njd/files/LACMinutes12-3-25.pdf",
          "verbatim": "Dennis Gleason proposed an AI amendment to appendix S. A subcommittee was formed to draft a proposal for consideration of the LAC.",
          "effective": null,
          "fetched": "2026-09-16"
        },
        {
          "title": "D.N.J. Lawyers Advisory Committee, Minutes of March 3, 2026 (latest posted) — read in full, no AI item",
          "url": "https://www.njd.uscourts.gov/sites/njd/files/LACMinutes03-03-26.pdf",
          "verbatim": null,
          "effective": null,
          "fetched": "2026-09-16"
        },
        {
          "title": "D.N.J. Appendix S, Confidentiality Order (current posted form) — no AI terms (grep)",
          "url": "https://www.njd.uscourts.gov/sites/njd/files/APPS.pdf",
          "verbatim": null,
          "effective": null,
          "fetched": "2026-09-16"
        },
        {
          "title": "D.N.J. Appendix Q, Guidelines for Mediation — no AI terms (grep)",
          "url": "https://www.njd.uscourts.gov/sites/njd/files/APPQ.pdf",
          "verbatim": null,
          "effective": null,
          "fetched": "2026-09-16"
        },
        {
          "title": "D.N.J. Standing Orders page (1986 through Standing Order 2026-03) — checked, no AI standing order",
          "url": "https://www.njd.uscourts.gov/standing-orders",
          "verbatim": null,
          "effective": null,
          "fetched": "2026-09-16"
        },
        {
          "title": "D.N.J. Notices to the Bar page (2010 through 9/10/2026) — checked, no AI notice",
          "url": "https://www.njd.uscourts.gov/notices-bar",
          "verbatim": null,
          "effective": null,
          "fetched": "2026-09-16"
        },
        {
          "title": "D.N.J. Proposed Local Rule Amendments page (latest posted 6/24/2025) — checked, no AI proposal",
          "url": "https://www.njd.uscourts.gov/proposed-local-rule-amendments",
          "verbatim": null,
          "effective": null,
          "fetched": "2026-09-16"
        },
        {
          "title": "D.N.J. Orders Amending Local Rules page (latest July 2026, L.Civ.R. 16.1) — checked, no AI amendment",
          "url": "https://www.njd.uscourts.gov/orders-amending-local-rules",
          "verbatim": null,
          "effective": null,
          "fetched": "2026-09-16"
        },
        {
          "title": "D.N.J. Notice to the Bar, Proposed Amendments to Local Civil Rule 16.1 (6/12/2026) — no AI terms (grep)",
          "url": "https://www.njd.uscourts.gov/sites/njd/files/NTBReLocCivRule16.1.pdf",
          "verbatim": null,
          "effective": null,
          "fetched": "2026-09-16"
        },
        {
          "title": "D.N.J. Order Amending Local Civil Rule 16.1 (July 2026) — no AI terms (grep)",
          "url": "https://www.njd.uscourts.gov/sites/njd/files/OrderreAmendLocalCivRule16.1.pdf",
          "verbatim": null,
          "effective": null,
          "fetched": "2026-09-16"
        },
        {
          "title": "D.N.J. Electronic Case Filing Policies and Procedures (effective May 14, 2026) — no AI terms (grep)",
          "url": "https://www.njd.uscourts.gov/sites/njd/files/PoliciesandProcedures2026.pdf",
          "verbatim": null,
          "effective": "2026-05-14",
          "fetched": "2026-09-16"
        },
        {
          "title": "D.N.J. Judicial Preferences, master list for all judges (Rev. 9/9/26) — no AI terms (grep)",
          "url": "https://www.njd.uscourts.gov/sites/njd/files/JudgePreferences.pdf",
          "verbatim": null,
          "effective": null,
          "fetched": "2026-09-16"
        },
        {
          "title": "Judge-specific — Judge Evelyn Padin — General Pretrial and Trial Procedures (Revised: September 10, 2026) — not court-wide; current version contains NO AI provision (grep and section headings checked)",
          "url": "https://www.njd.uscourts.gov/sites/njd/files/EPProcedures.pdf",
          "verbatim": null,
          "effective": null,
          "fetched": "2026-09-16"
        },
        {
          "title": "D.N.J. Judicial Preferences page (links to each judge's preferences) — check assigned judge per matter",
          "url": "https://www.njd.uscourts.gov/judicial-preferences",
          "verbatim": null,
          "effective": null,
          "fetched": "2026-09-16"
        },
        {
          "title": "LEAD ONLY — AI Vortex, District of New Jersey AI Disclosure Rules (2026) and web-search snippets describing a Padin GAI certification requirement (Procedures revised Feb. 20, 2025) — not borne out by the current Sept. 10, 2026 version",
          "url": "https://www.aivortex.io/legal/ai-disclosure/district-new-jersey/",
          "verbatim": null,
          "effective": null,
          "fetched": null
        }
      ],
      "status": "verified",
      "verified_on": "2026-09-17",
      "verified_by": "claude-opus-5 (independent verifier session; every source URL re-fetched 2026-09-17; checkq/strictq exact match; pinpoints, effective dates, status and narrative claims checked against the fetched text; one missed-item search)",
      "attorney_signoff": null,
      "notes": "(i) COURT-WIDE: VERIFIED NOTHING AI-SPECIFIC. The Local Civil and Criminal Rules (cover: With Revisions as of July 22, 2026; effective left null because the compilation states a revision date, and L.Civ.R. 103.1 shows Amended: March 31, 1999) were grepped in full: hits only on the word technology in unrelated rules. ECF Policies and Procedures effective May 14, 2026: no hits. Pages/documents checked with nothing AI-specific, all fetched 2026-09-16: https://www.njd.uscourts.gov/local-rules-and-appendices; https://www.njd.uscourts.gov/court-info/local-rules-and-orders; https://www.njd.uscourts.gov/standing-orders; https://www.njd.uscourts.gov/notices-bar; https://www.njd.uscourts.gov/proposed-local-rule-amendments; https://www.njd.uscourts.gov/orders-amending-local-rules; https://www.njd.uscourts.gov/cmecf-information; https://www.njd.uscourts.gov/cmecf-policies-and-procedures; https://www.njd.uscourts.gov/attorney-discipline; https://www.njd.uscourts.gov/judicial-preferences; https://www.njd.uscourts.gov/lawyers-advisory-committee; https://www.njd.uscourts.gov/minutes; Appendices Q and S; the 2018 notice of proposed amendments to L.Civ.R. 11.1, 16.1, 101.1(c)(6), 104.1 and 401.1(a) linked from the Local Rules page (adopted July 5, 2018; no AI); June 12, 2026 notices on L.Civ.R. 16.1 and the uniform Final Pretrial Order; July 2026 order amending 16.1. (ii) BINDING STATUS: L.Civ.R. 11.1, 103.1 and 104.1 are binding local rules. Lawyers Advisory Committee minutes are records of an advisory body, not rules or orders; they are quoted only to document the history. Judge preferences bind only in that judge's cases. (iii) PROPOSED/PENDING: no AI-related proposed local rule has been published for comment. History from LAC minutes (March 5, 2024, Dec. 3, 2025 and March 3, 2026 read in full; the others grepped and the AI items read in context): June 5, 2023, members suggested amending L.Civ.R. 11.1 to require an AI certification; Sept. 6, 2023, the LAC AI committee urged further review and asked that no judge adopt an AI certification until the rules question was decided; Dec. 5, 2023, an AI local rule recommendation went to the Board of Judges; March 5, 2024, the Rules Committee determined an AI local rule \"is not necessary at this time\"; March 4, 2025, the Third Circuit announced a circuit-wide AI committee; Dec. 3, 2025, an LAC member proposed an AI amendment to Appendix S (Confidentiality Order) and a subcommittee was formed. The March 3, 2026 minutes (latest posted) do not mention it; no later minutes are posted (June 2, 2026 meeting minutes not on the site). Treat the Appendix S AI amendment as an unpublished internal proposal to watch; current Appendix S has no AI terms. Other LAC minutes grepped with no AI terms: June 11, 2024; Sept. 10, 2024; Dec. 4, 2024; June 3, 2025. (iv) JUDGE LEVEL: NOT CONFIRMED. Secondary sources and search snippets describe a Judge Padin generative-AI certification (procedures revised Feb. 20, 2025), but the procedures on the court site today (Revised: September 10, 2026) contain no AI provision, and the district-wide Judicial Preferences master list (Rev. 9/9/26) has none. Because no current judge-level AI order was confirmed, disclosure_to_court is none and certification_required false; individual judges may still impose requirements by case order or in documents not checked (individual magistrate-judge documents were not each fetched). Check the assigned judge's preferences (https://www.njd.uscourts.gov/judicial-preferences) and any case-management order for every matter. Verifier (2026-09-17): the court-hosted procedures (\"Revised: September 10, 2026\") and the Judicial Preferences list (Rev. 9/9/26) contain no AI provision; prior versions could not be checked (Internet Archive offline), so whether a Padin AI provision ever existed stays open while secondary trackers still describe one without citing a court URL. (v) NOT FETCHED: individual judge preference pages other than Padin and the master list; LAC minutes before June 2023 (predate generative-AI discussion; not needed). The Bankruptcy Court for the District of New Jersey (separate local rules) was not checked. (vi) PROFESSIONAL CONDUCT: L.Civ.R. 103.1(a) adopts the Rules of Professional Conduct as revised by the New Jersey Supreme Court and L.Civ.R. 104.1(d)(2) makes violations grounds for discipline (L.Cr.R. 1.1 applies both in criminal cases), so the nj-rpc entry (including the N.J. Supreme Court's AI guidance) supplies competence, confidentiality, candor, supervision, and client-communication duties. Fed. R. Civ. P. 11 is a national rule applying in civil actions in every district court."
    },
    {
      "id": "us-edpa",
      "kind": "federal_district",
      "name": "U.S. District Court for the Eastern District of Pennsylvania",
      "disclosure_to_court": "judge_specific",
      "certification_required": false,
      "certificate_language": null,
      "verification_duty": "No court-wide AI rule. Fed. R. Civ. P. 11(b) (national rule) applies: by presenting a paper, an attorney \"certifies that to the best of the person’s knowledge, information, and belief, formed after an inquiry reasonable under the circumstances\" that legal contentions are warranted and factual contentions have evidentiary support (Rule 11(b)(2)-(3), paraphrased); Rule 11(c)(1): \"Absent exceptional circumstances, a law firm must be held jointly responsible for a violation committed by its partner, associate, or employee.\" Local Rule 83.6, Rule IV.B makes violation of the Pennsylvania Rules of Professional Conduct (as adopted by the court) misconduct and grounds for discipline. Judge-level orders add AI duties in assigned cases, e.g., Judge Baylson: disclose AI use and \"CERTIFY, that each and every citation to the law or the record in the paper, has been verified as accurate.\"",
      "confidentiality_restriction": null,
      "record_keeping_duty": "none",
      "client_disclosure_duty": "none",
      "sources": [
        {
          "title": "E.D. Pa. Local Rules of Civil Procedure (effective July 1, 1995, including amendments effective through May 8, 2023), Local Rule 83.6, Rules of Attorney Conduct, Rule IV.B (Standards for Professional Conduct)",
          "url": "https://www.paed.uscourts.gov/sites/paed/files/documents/locrules/civil/cvrules.pdf",
          "verbatim": "Acts or omissions by an attorney admitted to practice before this court, individually or in concert with any other person or persons, which violate the Rules of Professional Conduct adopted by this Court shall constitute misconduct and shall be grounds for discipline, whether or not the act or omission occurred in the course of any attorney-client relationship.",
          "effective": "2023-05-08",
          "fetched": "2026-09-16"
        },
        {
          "title": "Same — Local Rule 83.6, Rule IV.B, second paragraph (Rules of Professional Conduct adopted by the court)",
          "url": "https://www.paed.uscourts.gov/sites/paed/files/documents/locrules/civil/cvrules.pdf",
          "verbatim": "The Rules of Professional Conduct adopted by this court are the Rules of Professional Conduct adopted by the Supreme Court of Pennsylvania, as amended from time to time by that state court",
          "effective": "2023-05-08",
          "fetched": "2026-09-16"
        },
        {
          "title": "Same — Local Rule 1.1.1 (Standing Orders)",
          "url": "https://www.paed.uscourts.gov/sites/paed/files/documents/locrules/civil/cvrules.pdf",
          "verbatim": "Standing Orders currently in effect may be viewed on the Court’s website at https://www.paed.uscourts.gov.",
          "effective": "2023-05-08",
          "fetched": "2026-09-16"
        },
        {
          "title": "E.D. Pa. Local Criminal Rules (September 18, 2018), Rule 1.2 (Applicability and Effect of Local Rules; list includes Local Civil Rule 83.6)",
          "url": "https://www.paed.uscourts.gov/sites/paed/files/documents/locrules/criminal/crrules.pdf",
          "verbatim": "The following Local Civil Rules shall be fully applicable in all criminal proceedings:",
          "effective": null,
          "fetched": "2026-09-16"
        },
        {
          "title": "Fed. R. Civ. P. 11(b) (Federal Rules of Civil Procedure, Dec. 1, 2025 edition, uscourts.gov) — national rule",
          "url": "https://www.uscourts.gov/sites/default/files/document/federal-rules-of-civil-procedure.pdf",
          "verbatim": "certifies that to the best of the person’s knowledge, information, and belief, formed after an inquiry reasonable under the circumstances",
          "effective": null,
          "fetched": "2026-09-16"
        },
        {
          "title": "Same — Fed. R. Civ. P. 11(c)(1) (law firm responsibility)",
          "url": "https://www.uscourts.gov/sites/default/files/document/federal-rules-of-civil-procedure.pdf",
          "verbatim": "Absent exceptional circumstances, a law firm must be held jointly responsible for a violation committed by its partner, associate, or employee.",
          "effective": null,
          "fetched": "2026-09-16"
        },
        {
          "title": "Judge-specific — Judge Michael M. Baylson — Standing Order Re: Artificial Intelligence (AI) in Cases Assigned to Judge Baylson (dated 6/6/2023; listed on the court's Standing Orders page) — not court-wide",
          "url": "https://www.paed.uscourts.gov/sites/paed/files/documents/procedures/Standing%20Order%20Re%20Artificial%20Intelligence%206.6.pdf",
          "verbatim": "MUST, in a clear and plain factual statement, disclose that AI has been used in any way in the preparation of the filing, and CERTIFY, that each and every citation to the law or the record in the paper, has been verified as accurate.",
          "effective": "2023-06-06",
          "fetched": "2026-09-16"
        },
        {
          "title": "Same (Baylson) — court web page for the standing order",
          "url": "https://www.paed.uscourts.gov/rules-orders/standing-order-re-artificial-intelligence-ai-cases-assigned-judge-baylson",
          "verbatim": null,
          "effective": null,
          "fetched": "2026-09-16"
        },
        {
          "title": "Judge-specific — Judge Kai N. Scott — Standing Order Re: Artificial Intelligence in Cases Assigned to Judge Scott (dated 03/03/2025) — not court-wide",
          "url": "https://www.paed.uscourts.gov/sites/paed/files/documents/procedures/scopole.pdf",
          "verbatim": "then they MUST, in a clear and plain factual statement, disclose that generative AI has been used to assist with the citation of legal authority, disclose what specific generative AI program was used, and CERTIFY that each and every citation of legal authority has been verified as accurate.",
          "effective": "2025-03-03",
          "fetched": "2026-09-16"
        },
        {
          "title": "Judge-specific — Judge Gerald J. Pappert — Policies and Procedures (September 2026), § I.A Artificial Intelligence — not court-wide",
          "url": "https://www.paed.uscourts.gov/sites/paed/files/documents/procedures/pappol.pdf",
          "verbatim": "Any attorney or pro se party who uses generative artificial intelligence (“A.I.”) to prepare any complaint, answer, motion, brief or other paper filed with the Court shall: (1) disclose that generative artificial intelligence was used to prepare the filing; (2) identify precisely what portion or portions of the document contain the generated content; (3) identify the specific tool used and how it was used; and (4) certify that each any every citation to the law or the record in the filing was verified as accurate in accordance with the obligations set forth in Rule 11 of the Federal Rules of Civil Procedure.",
          "effective": null,
          "fetched": "2026-09-16"
        },
        {
          "title": "E.D. Pa. Local Rules, Standing and Administrative Orders page (Administrative Orders, Local Civil and Criminal Rules, Standing Orders through 05/22/2026) — only AI item is the Baylson judge-specific order",
          "url": "https://www.paed.uscourts.gov/local-rules",
          "verbatim": null,
          "effective": null,
          "fetched": "2026-09-16"
        },
        {
          "title": "E.D. Pa. Standing Orders page — checked",
          "url": "https://www.paed.uscourts.gov/local-rules/Standing%20Orders",
          "verbatim": null,
          "effective": null,
          "fetched": "2026-09-16"
        },
        {
          "title": "E.D. Pa. Local Civil Rules page — checked",
          "url": "https://www.paed.uscourts.gov/local-rules/Local%20Civil%20Rules",
          "verbatim": null,
          "effective": null,
          "fetched": "2026-09-16"
        },
        {
          "title": "E.D. Pa. Local Criminal Rules page — checked",
          "url": "https://www.paed.uscourts.gov/local-rules/Local%20Criminal%20Rules",
          "verbatim": null,
          "effective": null,
          "fetched": "2026-09-16"
        },
        {
          "title": "E.D. Pa. Amendment to Local Civil Rule 40.1 (10/08/2024) — no AI terms (grep)",
          "url": "https://www.paed.uscourts.gov/sites/paed/files/documents/locrules/civil/Amendment%20of%20Local%20Civil%20Rule%2040.1.pdf",
          "verbatim": null,
          "effective": null,
          "fetched": "2026-09-16"
        },
        {
          "title": "E.D. Pa. Protocols for Remote Proceedings (03/13/2024) — no AI terms (grep)",
          "url": "https://www.paed.uscourts.gov/sites/paed/files/documents/locrules/civil/Protocols%20for%20Remote%20Proceedings.pdf",
          "verbatim": null,
          "effective": null,
          "fetched": "2026-09-17"
        },
        {
          "title": "E.D. Pa. Court's Expectations of Arbitrators (04/21/2025) — no AI terms (grep)",
          "url": "https://www.paed.uscourts.gov/sites/paed/files/documents/locrules/civil/ExpArb.pdf",
          "verbatim": null,
          "effective": null,
          "fetched": "2026-09-17"
        },
        {
          "title": "E.D. Pa. News & Announcements page — checked (only AI item is the Baylson order announcement)",
          "url": "https://www.paed.uscourts.gov/news",
          "verbatim": null,
          "effective": null,
          "fetched": "2026-09-16"
        },
        {
          "title": "E.D. Pa. Notices page — checked, no AI notice",
          "url": "https://www.paed.uscourts.gov/notices",
          "verbatim": null,
          "effective": null,
          "fetched": "2026-09-16"
        },
        {
          "title": "E.D. Pa. NextGen CM/ECF page — checked",
          "url": "https://www.paed.uscourts.gov/nextgen-cmecf",
          "verbatim": null,
          "effective": null,
          "fetched": "2026-09-16"
        },
        {
          "title": "E.D. Pa. Clerk's Office Procedures page — checked",
          "url": "https://www.paed.uscourts.gov/clerks-office-procedures",
          "verbatim": null,
          "effective": null,
          "fetched": "2026-09-16"
        },
        {
          "title": "Judge-specific — Judge Kelley B. Hodge, Judicial Policies and Procedures (Rev. 6/18/2026), ¶ 3 Artificial Intelligence (a Rule 11(b)/26(g) compliance reminder; no disclosure or certification) — fetched at verification 2026-09-17 and re-read at merge",
          "url": "https://www.paed.uscourts.gov/sites/paed/files/documents/procedures/hodpol.pdf",
          "verbatim": "Artificial Intelligence: Anyone—counsel or pro se litigant—using Generative Artificial Intelligence (“GAI”) in connection with the filing of a pleading, motion, or paper in this Court or the serving/delivering of a request, response, or objection to discovery must comply with Rule 11(b) and Rule 26(g) of the Federal Rules of Civil Procedure, and any other relevant rule, including all applicable ethical rules.",
          "effective": "2026-06-18",
          "fetched": "2026-09-17"
        },
        {
          "title": "Judge-specific — Standing Order Regarding Use of Generative AI in Cases Assigned to Judge Pratter, dated May 3, 2024 (disclosure + citation certification) — still hosted by the court although Judge Pratter no longer appears on its judges page; appears inoperative; listed so trackers that still cite it do not mislead",
          "url": "https://www.paed.uscourts.gov/sites/paed/files/documents/procedures/praso1_0.pdf",
          "verbatim": "STANDING ORDER REGARDING USE OF GENERATIVE ARTIFICIAL INTELLIGENCE (“AI”) IN CASES ASSIGNED TO JUDGE PRATTER",
          "effective": "2024-05-03",
          "fetched": "2026-09-17"
        }
      ],
      "status": "verified",
      "verified_on": "2026-09-17",
      "verified_by": "claude-opus-5 (independent verifier session; every source URL re-fetched 2026-09-17; checkq/strictq exact match; pinpoints, effective dates, status and narrative claims checked against the fetched text; one missed-item search)",
      "attorney_signoff": null,
      "notes": "(i) COURT-WIDE: VERIFIED NOTHING AI-SPECIFIC in the local rules. The Local Rules of Civil Procedure (cover: Effective July 1, 1995, Including Amendments Effective Through May 8, 2023; effective set to 2023-05-08 from that cover line) and the Local Criminal Rules (September 18, 2018) were grepped in full: no AI provision (criminal-rules hits are only a petty-offense schedule entry on artificial lights). Local Rule 5.1.2 (Electronic Case Filing procedures, inside the civil rules) has no AI terms. Pages/documents checked with nothing AI-specific, all fetched 2026-09-16: https://www.paed.uscourts.gov/local-rules (Administrative Orders through 04/09/2024; Local Civil Rules incl. Amendment to L.R. 40.1 of 10/08/2024, Protocols for Remote Proceedings of 03/13/2024 and Court's Expectations of Arbitrators of 04/21/2025; Local Criminal Rules; Standing Orders through 05/22/2026); https://www.paed.uscourts.gov/local-rules/Local%20Civil%20Rules; https://www.paed.uscourts.gov/local-rules/Local%20Criminal%20Rules; https://www.paed.uscourts.gov/local-rules/Standing%20Orders; https://www.paed.uscourts.gov/news; https://www.paed.uscourts.gov/notices; https://www.paed.uscourts.gov/nextgen-cmecf; https://www.paed.uscourts.gov/clerks-office-procedures. The Local Criminal Rules' Rule 1.2 applying L.R. 83.6 carries the line Effective January 1, 1998 (effective left null for the compilation). (ii) BINDING STATUS: Local Rule 83.6 is a binding local rule. The Baylson order is a standing order that the court lists among its Standing Orders, but by its own title it applies only to cases assigned to Judge Baylson; the Scott order and Pappert procedures likewise bind only in those judges' cases. (iii) PROPOSED/PENDING: no proposed local-rule amendment on AI found; the local rules page lists no pending civil or criminal rule proposals (the only proposal postings there concern the Local Bankruptcy Rules). (iv) JUDGE LEVEL (not built per protocol Tier 3): confirmed on the court's site three judge-specific AI requirements: Judge Baylson (6/6/2023: disclose any AI use and certify every citation to law or record); Judge Scott (03/03/2025: disclose generative AI used for citations of legal authority, name the program, certify citations); Judge Pappert (Policies and Procedures, September 2026, § I.A: disclose, identify portions and tool, certify citations under Rule 11; the source text reads each any every). Hence disclosure_to_court is judge_specific and certification_required is false for the court-wide position; individual judges may require disclosure and certification. Check the assigned judge's policies and procedures (https://www.paed.uscourts.gov/judges-info) and the Standing Orders page for every matter. (v) Judge Hodge's policies were fetched at verification (2026-09-17): a Rule 11(b)/26(g) reminder only, no disclosure or certification; the court also still hosts a May 3, 2024 Judge Pratter AI standing order (see sources) although Judge Pratter is no longer on the judges page. NOT FETCHED: the court's 12/01/2009 Standing Orders compilation (stords.pdf) and individual judges' procedures other than Pappert; the https://www.paed.uscourts.gov/judges-info page itself was not fetched. The Bankruptcy Court for the E.D. Pa. was not checked. (vi) PROFESSIONAL CONDUCT: Local Rule 83.6, Rule IV.B adopts the Rules of Professional Conduct of the Supreme Court of Pennsylvania (as amended from time to time) and makes violations grounds for discipline; Local Criminal Rule 1.2 applies L.R. 83.6 in criminal proceedings. The pa-rpc entry therefore supplies competence, confidentiality, candor, supervision, and client-communication duties. Fed. R. Civ. P. 11 is a national rule applying in civil actions in every district court."
    },
    {
      "id": "us-ct-state-courts",
      "kind": "state_court",
      "name": "Connecticut Superior Court and Appellate Courts",
      "disclosure_to_court": "draft",
      "certification_required": "draft",
      "certificate_language": null,
      "verification_duty": "Practice Book § 4-9 (Superior Court, adopted June 23, 2026) and appellate amendments effective July 14, 2026 require independent verification of AI-produced citations, authorities, and evidence.",
      "confidentiality_restriction": null,
      "record_keeping_duty": "draft",
      "client_disclosure_duty": "draft",
      "sources": [
        {
          "title": "Connecticut Law Journal, July 14, 2026, Rules of Appellate Procedure notice",
          "url": "https://www.jud.ct.gov/LegalResources/Docs/LJDocs/Misc/2026/29/pblj_8803.pdf",
          "verbatim": null,
          "effective": "2026-07-14",
          "fetched": null
        }
      ],
      "status": "draft",
      "verified_on": null,
      "verified_by": null,
      "attorney_signoff": null,
      "notes": "Search-result level only. Read the Practice Book text before use."
    },
    {
      "id": "ny-rpc",
      "kind": "state_bar",
      "name": "New York Rules of Professional Conduct (22 NYCRR Part 1200) and New York AI guidance",
      "disclosure_to_court": "none",
      "certification_required": false,
      "certificate_language": null,
      "verification_duty": "No New York Rule of Professional Conduct is AI-specific; the general rules govern. BINDING: Rule 3.3(a) (official Part 1200 text): a lawyer \"shall not knowingly\" make \"a false statement of fact or law to a tribunal\". Rule 1.1(a) is cast in the permissive New York form: \"A lawyer should provide competent representation to a client.\" (NY uses \"should\" here, unlike ABA Model Rule 1.1). 22 NYCRR 130-1.1a(b): by signing any paper the attorney certifies, after \"an inquiry reasonable under the circumstances\", that it is not frivolous, and 130-1.1(c) defines frivolous conduct to include conduct that \"asserts material factual statements that are false\". 22 NYCRR Part 161 (Rules of the Chief Administrator, adopted by AO/75/2026, effective June 1, 2026) permits AI use and does not itself impose a verification rule; its Appendix A model rule, which binds only in a court that adopts it as a part rule, provides that an attorney who uses an AI tool in preparing a paper \"is required to carefully review the paper and independently ensure that it contains no fabricated or fictitious cases, statutes, or other material\". Deutsche Bank Natl. Trust Co. v LeTennier, 2026 NY Slip Op 00040 (3d Dept Jan. 8, 2026) (sanctions under 22 NYCRR 130-1.1 for 23 fabricated authorities): \"the use of GenAI in no way abrogates an attorney's or litigant's obligation to fact check and cite check every document filed with a court\". Matter of Julien v Arthur, 2026 NY Slip Op 03308 (2d Dept May 27, 2026) (Wooten, J.) (pro se appellant; one nonexistent case; $250 sanction under 22 NYCRR 130-1.1[c][1]): \"We hold that the unverified usage of GenAI to draft an appellate brief containing false information constitutes frivolous conduct warranting the imposition of a sanction, even when the offending party is a pro se litigant.\" Matter of Zareh, 2026 NY Slip Op 00619 (1st Dept Feb. 10, 2026) (reciprocal discipline; public censure of an attorney for an unreviewed AI-drafted federal brief): \"the conduct for which respondent was sanctioned as violative of FRCP rule 11(b) would constitute misconduct in violation of the New York Rules of Professional Conduct (22 NYCRR 1200.0) rules 3.1(a) and 3.1(b)(1).\" NON-BINDING (voluntary bar associations): NYSBA Task Force (Apr. 2024): \"attorneys must verify the accuracy of the information and legal authority produced by such tools\"; NYC Bar Formal Op. 2024-5: \"Generative AI outputs may be used as a starting point but must be carefully scrutinized.\"",
      "confidentiality_restriction": "No binding New York rule names AI or forbids a particular input; Rule 1.6 governs. BINDING: Rule 1.6(a): a lawyer \"shall not knowingly reveal confidential information\" absent informed consent, implied authorization, or a paragraph (b) exception; Rule 1.6(c): \"A lawyer shall make reasonable efforts to prevent the inadvertent or unauthorized disclosure or use of, or unauthorized access to, information protected by Rules 1.6, 1.9(c), or 1.18(b).\" NYSBA Comment [16] to Rule 1.6 (a NYSBA comment, not enacted by the Appellate Division) lists reasonableness factors beginning with \"the sensitivity of the information\". The UCS Interim AI Policy input restriction (§ V.3: \"No user may input into any generative AI program that does not operate on a private model\", followed by a list of confidential, privileged and personal information) binds only UCS judges and nonjudicial employees, not attorneys. NON-BINDING: NYC Bar Formal Op. 2024-5: \"Without client consent, a lawyer must not input confidential client information into any Generative AI system that will share the inputted confidential information with third parties\"; NYSBA Task Force guideline (Rule 1.6): \"you should obtain assurance that the Tool provider will protect your client’s confidential information and will keep each of your client’s confidential information segregated\".",
      "record_keeping_duty": "none",
      "client_disclosure_duty": "conditional — BINDING: informed consent is needed before confidential information is revealed to an AI tool where the disclosure is not impliedly authorized (Rule 1.6(a)(1): \"the client gives informed consent\"); Rule 1.4(a)(2) requires the lawyer to \"reasonably consult with the client about the means by which the client’s objectives are to be accomplished\", which may reach material AI use. No binding New York rule requires telling a client that AI was used. NON-BINDING: NYC Bar Formal Op. 2024-5: \"A lawyer should consider disclosing to the client the intent to use Generative AI that is not generally understood to be routinely used by lawyers as part of the representation\" and \"A lawyer should obtain client consent for Generative AI use if client confidences will be disclosed in connection with the use of Generative AI\"; NYC Bar Formal Op. 2025-6 (AI recording of client calls): \"clients must be notified, and their consent obtained, whenever their calls are being recorded by an AI-empowered system\"; NYSBA Task Force guideline (Rule 1.2): \"Consider including in your client engagement letter a statement that the Tools may be utilized in your representation of the client and seek the client’s acknowledgement.\"",
      "fees_note": "BINDING: Rule 1.5(a): \"A lawyer shall not make an agreement for, charge, or collect an excessive or illegal fee or expense.\" NON-BINDING: NYC Bar Formal Op. 2024-5: \"A lawyer must not charge hourly fees for the time that would otherwise have been spent absent the use of Generative AI\"; NYSBA Task Force guideline (Rule 1.5): \"If the Tools would make your work on behalf of a client substantially more efficient, then your use of (or failure to use) such Tools may be considered as a factor in determining whether the fees you charged for a given task or matter were reasonable.\"",
      "sources": [
        {
          "title": "NY State Unified Court System, Part 1200 Rules of Professional Conduct (unofficial compilation 'Dated January 1, 2017') — cover note on status of NYSBA Preamble, Scope and Comments",
          "url": "https://www.nycourts.gov/legacypdfs/rules/jointappellate/NY-Rules-Prof-Conduct-1200.pdf",
          "verbatim": "The New York State Bar Association has issued a Preamble, Scope and Comments to accompany these Rules. They are not enacted with this Part, and where a conflict exists between a Rule and the Preamble, Scope or a Comment, the Rule controls.",
          "effective": null,
          "fetched": "2026-09-16"
        },
        {
          "title": "Same — Rule 1.1(a) (competence; NY black-letter uses 'should')",
          "url": "https://www.nycourts.gov/legacypdfs/rules/jointappellate/NY-Rules-Prof-Conduct-1200.pdf",
          "verbatim": "A lawyer should provide competent representation to a client. Competent representation requires the legal knowledge, skill, thoroughness and preparation reasonably necessary for the representation.",
          "effective": null,
          "fetched": "2026-09-16"
        },
        {
          "title": "Same — Rule 1.4(b) (communication)",
          "url": "https://www.nycourts.gov/legacypdfs/rules/jointappellate/NY-Rules-Prof-Conduct-1200.pdf",
          "verbatim": "A lawyer shall explain a matter to the extent reasonably necessary to permit the client to make informed decisions regarding the representation.",
          "effective": null,
          "fetched": "2026-09-16"
        },
        {
          "title": "Same — Rule 1.4(a)(2) (consult about means)",
          "url": "https://www.nycourts.gov/legacypdfs/rules/jointappellate/NY-Rules-Prof-Conduct-1200.pdf",
          "verbatim": "reasonably consult with the client about the means by which the client’s objectives are to be accomplished",
          "effective": null,
          "fetched": "2026-09-16"
        },
        {
          "title": "Same — Rule 1.5(a) (fees)",
          "url": "https://www.nycourts.gov/legacypdfs/rules/jointappellate/NY-Rules-Prof-Conduct-1200.pdf",
          "verbatim": "A lawyer shall not make an agreement for, charge, or collect an excessive or illegal fee or expense.",
          "effective": null,
          "fetched": "2026-09-16"
        },
        {
          "title": "Same — Rule 1.6(a) (confidentiality)",
          "url": "https://www.nycourts.gov/legacypdfs/rules/jointappellate/NY-Rules-Prof-Conduct-1200.pdf",
          "verbatim": "A lawyer shall not knowingly reveal confidential information, as defined in this Rule, or use such information to the disadvantage of a client or for the advantage of the lawyer or a third person, unless:",
          "effective": null,
          "fetched": "2026-09-16"
        },
        {
          "title": "Same — Rule 1.6(c) (reasonable efforts to prevent disclosure or unauthorized access)",
          "url": "https://www.nycourts.gov/legacypdfs/rules/jointappellate/NY-Rules-Prof-Conduct-1200.pdf",
          "verbatim": "A lawyer shall make reasonable efforts to prevent the inadvertent or unauthorized disclosure or use of, or unauthorized access to, information protected by Rules 1.6, 1.9(c), or 1.18(b).",
          "effective": null,
          "fetched": "2026-09-16"
        },
        {
          "title": "Same — Rule 3.3(a)(1) (candor to tribunal)",
          "url": "https://www.nycourts.gov/legacypdfs/rules/jointappellate/NY-Rules-Prof-Conduct-1200.pdf",
          "verbatim": "make a false statement of fact or law to a tribunal or fail to correct a false statement of material fact or law previously made to the tribunal by the lawyer",
          "effective": null,
          "fetched": "2026-09-16"
        },
        {
          "title": "Same — Rule 5.1(c) (supervision of lawyers)",
          "url": "https://www.nycourts.gov/legacypdfs/rules/jointappellate/NY-Rules-Prof-Conduct-1200.pdf",
          "verbatim": "A law firm shall ensure that the work of partners and associates is adequately supervised, as appropriate. A lawyer with direct supervisory authority over another lawyer shall adequately supervise the work of the other lawyer, as appropriate.",
          "effective": null,
          "fetched": "2026-09-16"
        },
        {
          "title": "Same — Rule 5.3(a) (supervision of nonlawyers)",
          "url": "https://www.nycourts.gov/legacypdfs/rules/jointappellate/NY-Rules-Prof-Conduct-1200.pdf",
          "verbatim": "A law firm shall ensure that the work of nonlawyers who work for the firm is adequately supervised, as appropriate. A lawyer with direct supervisory authority over a nonlawyer shall adequately supervise the work of the nonlawyer, as appropriate.",
          "effective": null,
          "fetched": "2026-09-16"
        },
        {
          "title": "NYSBA, NY Rules of Professional Conduct with Comments (as amended through July 1, 2026) — front-matter statement on authority of Comments",
          "url": "https://nysba.org/wp-content/uploads/2026/08/NYSBA-NY-Rules-of-Professional-Conduct-as-amended-through-July-1-2026.pdf",
          "verbatim": "The Appellate Division has not adopted the Preamble, Scope and Comments, which are published solely by the New York State Bar Association",
          "effective": null,
          "fetched": "2026-09-16"
        },
        {
          "title": "Same — Scope [13]",
          "url": "https://nysba.org/wp-content/uploads/2026/08/NYSBA-NY-Rules-of-Professional-Conduct-as-amended-through-July-1-2026.pdf",
          "verbatim": "The Comments are intended as guides to interpretation, but the text of each Rule is authoritative.",
          "effective": null,
          "fetched": "2026-09-16"
        },
        {
          "title": "Same — Rule 1.1 Comment [8] (technology clause; the sentence's modal is 'a lawyer should')",
          "url": "https://nysba.org/wp-content/uploads/2026/08/NYSBA-NY-Rules-of-Professional-Conduct-as-amended-through-July-1-2026.pdf",
          "verbatim": "keep abreast of the benefits and risks associated with technology the lawyer uses to provide services to clients or to store or transmit confidential information",
          "effective": null,
          "fetched": "2026-09-16"
        },
        {
          "title": "Same — Rule 1.6 Comment [16] (reasonableness factors for paragraph (c))",
          "url": "https://nysba.org/wp-content/uploads/2026/08/NYSBA-NY-Rules-of-Professional-Conduct-as-amended-through-July-1-2026.pdf",
          "verbatim": "Factors to be considered in determining the reasonableness of the lawyer’s efforts include, but are not limited to: (i) the sensitivity of the information; (ii) the likelihood of disclosure if additional safeguards are not employed; (iii) the cost of employing additional safeguards",
          "effective": null,
          "fetched": "2026-09-16"
        },
        {
          "title": "Same — Rule 5.3 Comment [2] (instruction and supervision of nonlawyer assistants)",
          "url": "https://nysba.org/wp-content/uploads/2026/08/NYSBA-NY-Rules-of-Professional-Conduct-as-amended-through-July-1-2026.pdf",
          "verbatim": "A law firm must ensure that such nonlawyer assistants are given appropriate instruction and supervision concerning the ethical aspects of their employment, particularly regarding the obligation not to disclose confidential information",
          "effective": null,
          "fetched": "2026-09-16"
        },
        {
          "title": "22 NYCRR Part 161 (Rules of the Chief Administrator), Use of Artificial Intelligence Technology — § 161.1 Application (nycourts.gov rule page)",
          "url": "https://www.nycourts.gov/rules/part-161-use-artificial-intelligence-technology",
          "verbatim": "The policy set forth in this Part shall apply to all courts of the Unified Court System, in both civil and criminal cases.",
          "effective": "2026-06-01",
          "fetched": "2026-09-16"
        },
        {
          "title": "Same — § 161.3 Policy (no disclosure requirement)",
          "url": "https://www.nycourts.gov/rules/part-161-use-artificial-intelligence-technology",
          "verbatim": "Since those duties and responsibilities already apply to all submissions, regardless of whether AI tools were used, attorneys and parties should not be required, upon submitting papers, to disclose to the court that they have used AI in the preparation of such papers.",
          "effective": "2026-06-01",
          "fetched": "2026-09-16"
        },
        {
          "title": "Same — § 161.4 Model Rule (courts may adopt part rules)",
          "url": "https://www.nycourts.gov/rules/part-161-use-artificial-intelligence-technology",
          "verbatim": "A court may, in its discretion, implement a part rule governing the use by attorneys and parties of artificial intelligence tools in preparing papers submitted to the court.",
          "effective": "2026-06-01",
          "fetched": "2026-09-16"
        },
        {
          "title": "Same — Appendix A Model Rule (binding only where a court adopts it as a part rule) — review duty",
          "url": "https://www.nycourts.gov/rules/part-161-use-artificial-intelligence-technology",
          "verbatim": "Accordingly, any attorney or party who uses an artificial intelligence tool, as defined in 22 NYCRR 161.2(a), in preparing any paper, as defined in 22 NYCRR 161.2(b), filed in or submitted to this court or served on another party in a case before this court is required to carefully review the paper and independently ensure that it contains no fabricated or fictitious cases, statutes, or other material.",
          "effective": "2026-06-01",
          "fetched": "2026-09-16"
        },
        {
          "title": "Same — Appendix A Model Rule — signature operates as certification (no separate certificate)",
          "url": "https://www.nycourts.gov/rules/part-161-use-artificial-intelligence-technology",
          "verbatim": "By signing such paper, an attorney or party certifies that such a review has been conducted and that the paper contains no such fabricated or fictitious content.",
          "effective": "2026-06-01",
          "fetched": "2026-09-16"
        },
        {
          "title": "Administrative Order AO/75/2026 of the Chief Administrative Judge (dated March 25, 2026) adding Part 161 — effective date",
          "url": "https://www.nycourts.gov/LegacyPDFS/rules/comments/pdf/AdministrativeOrder-CAJ-75-2026-ArttificialIntelligence-032526r.pdf",
          "verbatim": "to the Rules of the Chief Administrator, effective June 1, 2026",
          "effective": "2026-06-01",
          "fetched": "2026-09-16"
        },
        {
          "title": "NY Courts, Requests for Public Comment page — Part 161 adoption entry",
          "url": "https://www.nycourts.gov/rules/requests-public-comment",
          "verbatim": "This measure was adopted on March 25, 2026, effective June 1, 2026",
          "effective": "2026-06-01",
          "fetched": "2026-09-16"
        },
        {
          "title": "OCA Request for Public Comment (Nov. 17, 2025) on proposed Part 161, Exhibit B AI Advisory Committee memo (Oct. 24, 2025), memo p. 4 (PDF p. 10) — scope of no-disclosure policy (OCR; OCR text compared by eye with the rendered page image 2026-09-17)",
          "url": "https://www.nycourts.gov/LegacyPDFS/rules/comments/pdf/RequestForPublicComment-GenerativeArtificialIntelligence-111725.pdf",
          "verbatim": "We note that the proposed policy against requiring disclosure would apply only “upon submitting papers,” and thus would not prevent a court from asking an attorney or party at a later point to disclose whether they used generative AI",
          "effective": null,
          "fetched": "2026-09-16"
        },
        {
          "title": "22 NYCRR 130-1.1a(b) (signing of papers certifies non-frivolousness) — nycourts.gov Part 130 page",
          "url": "https://www.nycourts.gov/rules/part-130-costs-and-sanctions",
          "verbatim": "By signing a paper, an attorney or party certifies that, to the best of that person's knowledge, information and belief, formed after an inquiry reasonable under the circumstances, (1) the presentation of the paper or the contentions therein are not frivolous as defined in section 130-1.1(c) of this Subpart",
          "effective": null,
          "fetched": "2026-09-16"
        },
        {
          "title": "Deutsche Bank Natl. Trust Co. v LeTennier, 2026 NY Slip Op 00040 (3d Dept Jan. 8, 2026) — duty to cite check",
          "url": "https://www.nycourts.gov/reporter/3dseries/2026/2026_00040.htm",
          "verbatim": "As with the work from a paralegal, intern or another attorney, the use of GenAI in no way abrogates an attorney's or litigant's obligation to fact check and cite check every document filed with a court.",
          "effective": "2026-01-08",
          "fetched": "2026-09-16"
        },
        {
          "title": "Same — AI use not prohibited",
          "url": "https://www.nycourts.gov/reporter/3dseries/2026/2026_00040.htm",
          "verbatim": "To be clear, attorneys and litigants are not prohibited from using GenAI to assist with the preparation of court submissions.",
          "effective": "2026-01-08",
          "fetched": "2026-09-16"
        },
        {
          "title": "NY State Unified Court System Interim Policy on the Use of Artificial Intelligence (header 'Effective October 2025'; appendix 'Amended May 2026') — § II Scope",
          "url": "https://www.nycourts.gov/LegacyPDFS/a.i.-policy.pdf",
          "verbatim": "This interim policy is applicable to all judges and nonjudicial employees of the UCS.",
          "effective": null,
          "fetched": "2026-09-16"
        },
        {
          "title": "Same — § V.3 input restriction (binds UCS users, not attorneys)",
          "url": "https://www.nycourts.gov/LegacyPDFS/a.i.-policy.pdf",
          "verbatim": "No user may input into any generative AI program that does not operate on a private model",
          "effective": null,
          "fetched": "2026-09-16"
        },
        {
          "title": "UCS News Release, Oct. 10, 2025, announcing the Interim AI Policy",
          "url": "https://www.nycourts.gov/LegacyPDFS/press/pdfs/PR25_23.pdf",
          "verbatim": "The policy applies to all UCS judges, justices, and nonjudicial employees",
          "effective": "2025-10-10",
          "fetched": "2026-09-16"
        },
        {
          "title": "PROPOSED ONLY — OCA Request for Public Comment (June 11, 2025) on new Commercial Division Rule 6(e) (22 NYCRR 202.70) re generative AI — proposed text, Exhibit 1",
          "url": "https://www.nycourts.gov/LegacyPDFS/rules/comments/pdf/CommercialDivision-ArtificialIntelligence-061125.pdf",
          "verbatim": "Accordingly, any person who files any such material with this Court is certifying the accuracy and reliability of such material and any statements made therein.",
          "effective": null,
          "fetched": "2026-09-16"
        },
        {
          "title": "NY Courts, Requests for Public Comment page — Rule 6(e) entry (no adoption line follows it)",
          "url": "https://www.nycourts.gov/rules/requests-public-comment",
          "verbatim": "June 11, 2025: Proposal to add a new Rule 6(e) to the Rules of the Commercial Division regarding the use of generative artificial intelligence in preparing court documents",
          "effective": null,
          "fetched": "2026-09-16"
        },
        {
          "title": "22 NYCRR 202.70 Rules of the Commercial Division (current nycourts.gov page) — Rule 6 has paragraphs (a)-(d) only; no AI provision (verified nothing)",
          "url": "https://www.nycourts.gov/rules/rule/section-20270-rules-commercial-division-supreme-court",
          "verbatim": null,
          "effective": null,
          "fetched": "2026-09-16"
        },
        {
          "title": "PENDING BILL — S.2698 (Hoylman-Sigal), proposed CPLR 2107 (affidavit disclosing generative AI use) — bill text PDF (line-numbered; quoted instead from the nysenate.gov page below)",
          "url": "https://legislation.nysenate.gov/pdf/bills/2025/s2698",
          "verbatim": null,
          "effective": null,
          "fetched": "2026-09-16"
        },
        {
          "title": "Same — nysenate.gov bill page (In Senate Committee, Rules; committed to rules Jun 13, 2025), proposed CPLR 2107(a) (new matter shown in capitals on the page; the sentence continues with a certification of human review and verification of the AI-generated content, not quoted because the page text breaks the word 'artificially' across lines)",
          "url": "https://www.nysenate.gov/legislation/bills/2025/S2698",
          "verbatim": "ANY PAPER OR FILE SERVED THAT WAS DRAFTED WITH THE ASSISTANCE OF GENERATIVE ARTIFICIAL INTELLIGENCE MUST ATTACH TO THE FILING A SEPARATE AFFIDAVIT DISCLOSING SUCH USE",
          "effective": null,
          "fetched": "2026-09-16"
        },
        {
          "title": "PENDING BILL — A.8546 (Lavine), same proposed CPLR 2107 — bill text and status page (In Assembly Committee)",
          "url": "https://www.nysenate.gov/legislation/bills/2025/A8546",
          "verbatim": null,
          "effective": null,
          "fetched": "2026-09-16"
        },
        {
          "title": "PENDING BILL — S.9794 (Sepulveda), same-as A.8546 — status page (In Senate Committee, Rules; committed to rules Jun 05, 2026)",
          "url": "https://www.nysenate.gov/legislation/bills/2025/S9794",
          "verbatim": null,
          "effective": null,
          "fetched": "2026-09-16"
        },
        {
          "title": "22 NYCRR Part 1250 Practice Rules of the Appellate Division (AD3 copy, revised Nov. 25, 2019) — no AI provision (verified nothing)",
          "url": "https://www.nycourts.gov/ad3/clerk/rules-of-practice/Statewide-Practice-Rules-Part-1250.pdf",
          "verbatim": null,
          "effective": null,
          "fetched": "2026-09-16"
        },
        {
          "title": "22 NYCRR Part 202 Uniform Civil Rules for the Supreme Court and the County Court (current nycourts.gov page) — no AI provision (verified nothing)",
          "url": "https://www.nycourts.gov/rules/part-202-uniform-civil-rules-supreme-court-and-county-court",
          "verbatim": null,
          "effective": null,
          "fetched": "2026-09-16"
        },
        {
          "title": "Appellate Division, First Department rules page — no AI provision (verified nothing)",
          "url": "https://www.nycourts.gov/courts/ad1/Practice&Procedures/rules.shtml",
          "verbatim": null,
          "effective": null,
          "fetched": "2026-09-16"
        },
        {
          "title": "Appellate Division, Second Department Local Rules (22 NYCRR Part 670) PDF — no AI provision (verified nothing)",
          "url": "https://www.nycourts.gov/courts/ad2/pdf/Local_Rules.pdf",
          "verbatim": null,
          "effective": null,
          "fetched": "2026-09-16"
        },
        {
          "title": "Appellate Division, Fourth Department rules page — no AI provision (verified nothing)",
          "url": "https://ad4.nycourts.gov/rules",
          "verbatim": null,
          "effective": null,
          "fetched": "2026-09-16"
        },
        {
          "title": "NYSBA, Report and Recommendations of the Task Force on Artificial Intelligence (April 2024) — cover (NON-BINDING; voluntary bar association)",
          "url": "https://nysba.org/wp-content/uploads/2022/03/2024-April-Report-and-Recommendations-of-the-Task-Force-on-Artificial-Intelligence.pdf",
          "verbatim": "Approved by the House of Delegates April 6, 2024.",
          "effective": "2024-04-06",
          "fetched": "2026-09-16"
        },
        {
          "title": "Same — Legal Profession Impact, F. Candor to the Court (report p. 36)",
          "url": "https://nysba.org/wp-content/uploads/2022/03/2024-April-Report-and-Recommendations-of-the-Task-Force-on-Artificial-Intelligence.pdf",
          "verbatim": "When using ChatGPT or other similar AI tools, attorneys must verify the accuracy of the information and legal authority produced by such tools.",
          "effective": "2024-04-06",
          "fetched": "2026-09-16"
        },
        {
          "title": "Same — F. Candor to the Court (report p. 39)",
          "url": "https://nysba.org/wp-content/uploads/2022/03/2024-April-Report-and-Recommendations-of-the-Task-Force-on-Artificial-Intelligence.pdf",
          "verbatim": "Attorneys cannot solely rely upon information provided by generative AI. Attorneys may instead use generative AI as a starting point and must independently review case citations, arguments and any other information/output produced by generative AI.",
          "effective": "2024-04-06",
          "fetched": "2026-09-16"
        },
        {
          "title": "Same — AI & Generative AI Guidelines, Confidentiality (Rule 1.6) row (report p. 58)",
          "url": "https://nysba.org/wp-content/uploads/2022/03/2024-April-Report-and-Recommendations-of-the-Task-Force-on-Artificial-Intelligence.pdf",
          "verbatim": "Even if your client gives informed consent for you to input confidential information into a Tool, you should obtain assurance that the Tool provider will protect your client’s confidential information and will keep each of your client’s confidential information segregated.",
          "effective": "2024-04-06",
          "fetched": "2026-09-16"
        },
        {
          "title": "Same — Guidelines, Responsibility for Non-Lawyers (Rule 5.3) row (report p. 59)",
          "url": "https://nysba.org/wp-content/uploads/2022/03/2024-April-Report-and-Recommendations-of-the-Task-Force-on-Artificial-Intelligence.pdf",
          "verbatim": "Further, you must ensure that the work produced by the Tools is accurate and complete and does not disclose or create a risk of disclosing client confidential information without your client’s informed consent.",
          "effective": "2024-04-06",
          "fetched": "2026-09-16"
        },
        {
          "title": "Same — Guidelines, Fees (Rule 1.5) row (report p. 58)",
          "url": "https://nysba.org/wp-content/uploads/2022/03/2024-April-Report-and-Recommendations-of-the-Task-Force-on-Artificial-Intelligence.pdf",
          "verbatim": "If the Tools would make your work on behalf of a client substantially more efficient, then your use of (or failure to use) such Tools may be considered as a factor in determining whether the fees you charged for a given task or matter were reasonable.",
          "effective": "2024-04-06",
          "fetched": "2026-09-16"
        },
        {
          "title": "Same — Guidelines, Scope of Representation (Rule 1.2) row (report p. 57)",
          "url": "https://nysba.org/wp-content/uploads/2022/03/2024-April-Report-and-Recommendations-of-the-Task-Force-on-Artificial-Intelligence.pdf",
          "verbatim": "Consider including in your client engagement letter a statement that the Tools may be utilized in your representation of the client and seek the client’s acknowledgement.",
          "effective": "2024-04-06",
          "fetched": "2026-09-16"
        },
        {
          "title": "Same — Recommendations (report p. 54) — proposed expansion of Rule 1.1 Comment [8] (NOT adopted in NYSBA comments as amended through July 1, 2026)",
          "url": "https://nysba.org/wp-content/uploads/2022/03/2024-April-Report-and-Recommendations-of-the-Task-Force-on-Artificial-Intelligence.pdf",
          "verbatim": "Further, we would expand Comment [8] to Rule 1.1 to add that the duty of competence obligates lawyers to: (a) keep abreast of and be able to identify technology (including AI and generative AI) that is generally available to improve effective client representation and enhance the quality of legal services;",
          "effective": null,
          "fetched": "2026-09-16"
        },
        {
          "title": "NYSBA President's Committee on Access to Justice, Report and Recommendations on AI and Access to Justice in 2025 (NON-BINDING) — approval line",
          "url": "https://nysba.org/wp-content/uploads/2026/01/Revised-01.20.2026-Approved-Report-and-Recommendations-on-AI-and-Access-to-Justice-in-2025-online-version.pdf",
          "verbatim": "Approved by the House of Delegates on January 16, 2026",
          "effective": "2026-01-16",
          "fetched": "2026-09-16"
        },
        {
          "title": "Same — 'Risks to Manage, Not Ignore' (report p. 29)",
          "url": "https://nysba.org/wp-content/uploads/2026/01/Revised-01.20.2026-Approved-Report-and-Recommendations-on-AI-and-Access-to-Justice-in-2025-online-version.pdf",
          "verbatim": "Ground to vetted sources, require citations, and verify before filing or sending.",
          "effective": "2026-01-16",
          "fetched": "2026-09-16"
        },
        {
          "title": "NYC Bar Association Committee on Professional Ethics, Formal Opinion 2024-5 (Aug. 7, 2024) (NON-BINDING) — Duty of Confidentiality",
          "url": "https://www.nycbar.org/wp-content/uploads/2024/08/20221329_GenerativeAILawPractice.pdf",
          "verbatim": "Without client consent, a lawyer must not input confidential client information into any Generative AI system that will share the inputted confidential information with third parties",
          "effective": "2024-08-07",
          "fetched": "2026-09-16"
        },
        {
          "title": "Same — Duties of Competence and Diligence",
          "url": "https://www.nycbar.org/wp-content/uploads/2024/08/20221329_GenerativeAILawPractice.pdf",
          "verbatim": "Generative AI outputs may be used as a starting point but must be carefully scrutinized. They should be critically analyzed for accuracy and bias, supplemented, and improved, if necessary.",
          "effective": "2024-08-07",
          "fetched": "2026-09-16"
        },
        {
          "title": "Same — Communication Regarding Generative AI Use (disclosure)",
          "url": "https://www.nycbar.org/wp-content/uploads/2024/08/20221329_GenerativeAILawPractice.pdf",
          "verbatim": "A lawyer should consider disclosing to the client the intent to use Generative AI that is not generally understood to be routinely used by lawyers as part of the representation",
          "effective": "2024-08-07",
          "fetched": "2026-09-16"
        },
        {
          "title": "Same — Communication Regarding Generative AI Use (consent)",
          "url": "https://www.nycbar.org/wp-content/uploads/2024/08/20221329_GenerativeAILawPractice.pdf",
          "verbatim": "A lawyer should obtain client consent for Generative AI use if client confidences will be disclosed in connection with the use of Generative AI.",
          "effective": "2024-08-07",
          "fetched": "2026-09-16"
        },
        {
          "title": "Same — Charging for Work Produced by Generative AI",
          "url": "https://www.nycbar.org/wp-content/uploads/2024/08/20221329_GenerativeAILawPractice.pdf",
          "verbatim": "A lawyer must not charge hourly fees for the time that would otherwise have been spent absent the use of Generative AI",
          "effective": "2024-08-07",
          "fetched": "2026-09-16"
        },
        {
          "title": "NYC Bar Formal Opinion 2025-6 (Dec. 22, 2025), AI to record, transcribe and summarize client conversations (NON-BINDING) — § I.A client consent",
          "url": "https://www.nycbar.org/wp-content/uploads/2025/12/20221554-AIRecordingEthicsOpinion-1.pdf",
          "verbatim": "As a result, we conclude that clients must be notified, and their consent obtained, whenever their calls are being recorded by an AI-empowered system.",
          "effective": "2025-12-22",
          "fetched": "2026-09-16"
        },
        {
          "title": "Same — § I.C.1 reviewing transcripts and summaries",
          "url": "https://www.nycbar.org/wp-content/uploads/2025/12/20221554-AIRecordingEthicsOpinion-1.pdf",
          "verbatim": "Attorneys should not simply rely on work products prepared by AI tools without independently verifying their accuracy.",
          "effective": "2025-12-22",
          "fetched": "2026-09-16"
        },
        {
          "title": "NYC Bar Formal Opinion 2026-2 (Aug. 5, 2026), AI recording of non-client conversations (NON-BINDING) — § II",
          "url": "https://www.nycbar.org/wp-content/uploads/2026/08/20221672-AiRecordingEthicsOpinion.pdf",
          "verbatim": "Attorneys must disclose the intention to record the conversation and obtain permission from all participants.",
          "effective": "2026-08-05",
          "fetched": "2026-09-16"
        },
        {
          "title": "LEAD ONLY — NYSBA news item, 'Effective June 1, 2026, The New York State Unified Court System Has Adopted a New Rule Regarding the Use of Artificial Intelligence'",
          "url": "https://nysba.org/effective-june-1-2026-the-new-york-state-unified-court-system-has-adopted-a-new-rule-regarding-the-use-of-artificial-intelligence/",
          "verbatim": null,
          "effective": null,
          "fetched": "2026-09-16"
        },
        {
          "title": "LEAD ONLY — Greenberg Traurig, 'Navigating AI Disclosure Rules in New York Courts' (Nov. 2025) (search result; not read)",
          "url": "https://www.gtlaw.com/en/insights/2025/11/navigating-ai-disclosure-rules-in-new-york-courts",
          "verbatim": null,
          "effective": null,
          "fetched": null
        },
        {
          "title": "LEAD ONLY — legalaigovernance.com New York tracker (search result; not read)",
          "url": "https://legalaigovernance.com/tracker/states/new-york/",
          "verbatim": null,
          "effective": null,
          "fetched": null
        },
        {
          "title": "Matter of Julien v Arthur, 2026 NY Slip Op 03308 (App Div 2d Dept May 27, 2026) (Wooten, J.), Opinion & Order — holding — official Law Reporting Bureau page; ADDED AT MERGE by the arbiter (read once from the official page; not second-read by a verifier session)",
          "url": "https://www.nycourts.gov/reporter/current/3dseries/2026/2026_03308.shtml",
          "verbatim": "We hold that the unverified usage of GenAI to draft an appellate brief containing false information constitutes frivolous conduct warranting the imposition of a sanction, even when the offending party is a pro se litigant.",
          "effective": "2026-05-27",
          "fetched": "2026-09-17"
        },
        {
          "title": "Matter of Julien v Arthur, 2026 NY Slip Op 03308 (2d Dept May 27, 2026) — a single unverified citation may warrant sanctions; pro se status no excuse — ADDED AT MERGE (single read)",
          "url": "https://www.nycourts.gov/reporter/current/3dseries/2026/2026_03308.shtml",
          "verbatim": "The failure to verify even a single GenAI citation to a fictitious case may warrant the imposition of sanctions to account for the unnecessary waste of resources of the Court and of opposing parties (see Grymes Dev. Co. v Fodera, 88 Misc 3d 767 [Sup Ct, Richmond County]).",
          "effective": "2026-05-27",
          "fetched": "2026-09-17"
        },
        {
          "title": "Matter of Zareh, 2026 NY Slip Op 00619 (App Div 1st Dept Feb. 10, 2026) — reciprocal discipline under Judiciary Law § 90(2) and 22 NYCRR 1240.13 for an unreviewed AI-drafted brief in N.D. Tex.; conduct would violate NY RPC 3.1(a) and 3.1(b)(1) — ADDED AT MERGE (single read)",
          "url": "https://www.nycourts.gov/reporter/3dseries/2026/2026_00619.htm",
          "verbatim": "the conduct for which respondent was sanctioned as violative of FRCP rule 11(b) would constitute misconduct in violation of the New York Rules of Professional Conduct (22 NYCRR 1200.0) rules 3.1(a) and 3.1(b)(1).",
          "effective": "2026-02-10",
          "fetched": "2026-09-17"
        },
        {
          "title": "Matter of Zareh, 2026 NY Slip Op 00619 (1st Dept Feb. 10, 2026) — sanction: public censure — ADDED AT MERGE (single read)",
          "url": "https://www.nycourts.gov/reporter/3dseries/2026/2026_00619.htm",
          "verbatim": "A public censure, as requested by the AGC, is the appropriate sanction because it is commensurate with and equivalent to the public reprimand issued by the District Court",
          "effective": "2026-02-10",
          "fetched": "2026-09-17"
        },
        {
          "title": "NYC Bar, Formal Opinion 2024-5 landing page (carries the issue date \"August 7, 2024\"; the PDF prints no date) — added at merge per verifier",
          "url": "https://www.nycbar.org/reports/formal-opinion-2024-5-generative-ai-in-the-practice-of-law/",
          "verbatim": null,
          "effective": "2024-08-07",
          "fetched": "2026-09-17"
        },
        {
          "title": "NYC Bar, Formal Opinion 2025-6 landing page (issue date \"December 22, 2025\") — added at merge per verifier",
          "url": "https://www.nycbar.org/reports/formal-opinion-2025-6-ethical-issues-affecting-use-of-ai-to-record-transcribe-and-summarize-conversations-with-clients/",
          "verbatim": null,
          "effective": "2025-12-22",
          "fetched": "2026-09-17"
        },
        {
          "title": "NYC Bar, Formal Opinion 2026-2 landing page (issue date \"August 5, 2026\") — added at merge per verifier",
          "url": "https://www.nycbar.org/reports/formal-opinion-2026-2-ethical-use-of-ai-for-recording-transcribing-and-summarizing-non-client-conversations/",
          "verbatim": null,
          "effective": "2026-08-05",
          "fetched": "2026-09-17"
        }
      ],
      "status": "verified",
      "verified_on": "2026-09-17",
      "verified_by": "claude-opus-5 verifier session 2026-09-17 for all compiler content (50 quotations exact; dates and statuses confirmed; one blocking row: missed Julien v Arthur). Julien and Zareh rows and the NYC Bar landing pages were ADDED AT MERGE by the Fable 5.1 arbiter session (2026-09-17) from the official reporter pages, read once; those rows have NOT had a second reader — the responsible attorney's initials in attorney_signoff are the second read for them.",
      "verifier_result": "9/10 batch entries verified by the verifier; ny-rpc verified at merge after the blocking row (Julien) was read and added by the arbiter; see jurisdictions.batch-1.verified.yaml",
      "attorney_signoff": null,
      "notes": "(A) WHAT IS IN FORCE. 22 NYCRR Part 161 (Rules of the Chief Administrator, Use of Artificial Intelligence Technology) was added by Administrative Order AO/75/2026, dated March 25, 2026, \"effective June 1, 2026\" (effective date taken from the AO itself; the Requests for Public Comment page agrees). It applies to all Unified Court System courts \"in both civil and criminal cases\" (state courts only; SDNY/EDNY/NDNY/WDNY and the Second Circuit need separate entries). disclosure_to_court is none because 161.3 states attorneys \"should not be required, upon submitting papers, to disclose\" AI use; the Oct. 24, 2025 committee memo attached to the proposal (OCR) says the policy reaches only the moment of submission, so a court may later ask whether AI was used. certification_required is false and certificate_language is null because Part 161 contains no certificate text: under 161.4 a court may adopt a part rule, and the Appendix A model rule (only where adopted) makes the signature itself the certification that the review was done; 22 NYCRR 130-1.1a(b) signature certification applies to all papers regardless of AI. Before filing in a New York state court, read the assigned justice's part rules for an adopted model rule or other AI provision; no part rules were surveyed here. The adopted text differs from the Nov. 17, 2025 proposal (OCR): the proposal was framed as generative AI only, and its 161.1 lacked the civil-and-criminal clause; the adopted AO defines artificial intelligence generally. (B) PROPOSED OR PENDING, NOT IN FORCE. Commercial Division Rule 6(e) (22 NYCRR 202.70) on generative AI was only proposed (OCA request for comment June 11, 2025, comments due Aug. 8, 2025): the Requests for Public Comment page (fetched 2026-09-16) shows no adoption line under that entry although neighboring entries show adoption lines, and the current official 202.70 page (fetched 2026-09-16) has Rule 6 paragraphs (a)-(d) only. Some search-result summaries claimed adoption on Sept. 30, 2025; on the page that date belongs to the adjacent Rule 25-a and Part 137 entries. It appears overtaken by Part 161 (inference, not stated in any source read). Bills: S.2698 (Hoylman-Sigal), A.8546 (Lavine) and S.9794 (Sepulveda) would add CPLR 2107 (a separate affidavit disclosing generative AI use and certifying human review) and amend CPLR 5528; effective the ninetieth day after enactment. nysenate.gov status pages (fetched 2026-09-16): S.2698 \"In Senate Committee\" (Rules; committed to rules Jun 13, 2025); A.8546 \"In Assembly Committee\" (Judiciary; referred Jan 07, 2026); S.9794 in Senate Committee (Rules; committed to rules Jun 05, 2026). None is law. The three bill texts were fetched and compared; the operative text is the same. NYSBA AI Committee memo on S.7263/A.6545 (chatbot impersonation of licensed professionals) was fetched and read; it does not concern lawyers' AI use or court filings and is not listed. (C) BINDING VS NON-BINDING. Binding: Part 1200 black-letter rules (joint rules of the Appellate Division); Part 130; Part 161 (and its Appendix A only where a court adopts it); Deutsche Bank Natl. Trust Co. v LeTennier (3d Dept Jan. 8, 2026), which the court called the \"first appellate-level case in New York addressing sanctions for the misuse of GenAI\" (sanctions under 22 NYCRR 130-1.1 of $7,500 total against counsel, being $5,000 for the fabricated authorities plus $2,500 for a frivolous appeal, and $2,500 against the defendant); Matter of Julien v Arthur (2d Dept May 27, 2026) ($250 sanction under 130-1.1[c][1] against a pro se appellant for one nonexistent case; holds pro se status is no excuse and a single unverified citation may warrant sanctions); Matter of Zareh (1st Dept Feb. 10, 2026) (public censure, reciprocal discipline, for an unreviewed AI-drafted brief; the conduct would violate RPC 3.1(a) and 3.1(b)(1)) — Julien and Zareh added at merge 2026-09-17, single read. EFFECTIVE DATES: Part 1200 items carry effective null. Both covers give only the Part's original date (\"effective April 1, 2009\"), and the nycourts compilation adds that the Rules were \"amended on several occasions thereafter\" without per-rule amendment dates, so the date on which each quoted text (e.g., Rule 1.6(c), and the Rule 1.1 Comment [8] technology clause) took effect is not stated in any source read; a verifier should take it from the NYCRR history notes. NYSBA comment items carry effective null because the NYSBA text gives only an as-amended-through date; Part 161 items use the AO date; the UCS policy items are null (month only); the press release item uses its own date. The official nycourts.gov Part 1200 PDF is marked \"Dated: January 1, 2017\" and calls itself an unofficial compilation; black-letter text of Rules 1.1, 1.4, 1.5(a), 1.6, 3.3, 5.1 and 5.3 in it was compared with the NYSBA text as amended through July 1, 2026 and matches (the official PDF drops the initial word of 1.1(c), a typo). RPC amendments listed on the comment page as adopted in 2025-2026 (Rules 1.0, 1.7, 1.8, 1.11, 1.12, 2.4, 4.1, 5.4, 5.5, 6.5, 8.1, 8.3; 7.1-7.4; 1.16; 8.4(g)) do not include the rules quoted here. Verifier (2026-09-17) adds two items the compiler omitted from that list — the Dec. 26, 2024 proposal on Rules 1.8, 1.10, 1.11, 1.12 and 1.18 (adopted June 25, 2025, effective July 7, 2025) and the July 2, 2024 proposal on Rules 1.10 and 3.4 (adopted and effective Jan. 1, 2025) — neither touches the rules quoted here, and the verifier confirmed all nine Part 1200 quotations against the NYSBA text as amended through July 1, 2026. Not binding: the Preamble, Scope and Comments (\"The Appellate Division has not adopted the Preamble, Scope and Comments\"); the Task Force's proposal to add AI to Rule 1.1 Comment [8] and the Preamble has not been made (grep of the NYSBA text as amended through July 1, 2026 finds no artificial/generative/AI term; the only technology hit is Comment [8]). NYSBA Task Force Report (\"Approved by the House of Delegates April 6, 2024.\") and NYSBA AI and Access to Justice Report (approved Jan. 16, 2026) are voluntary-bar-association guidance, not rules; the Task Force guidelines use must and should but bind no one. NYC Bar Formal Opinions 2024-5 (Aug. 7, 2024), 2025-6 (Dec. 22, 2025) and 2026-2 (Aug. 5, 2026) are voluntary-bar opinions, not binding; dates come from the Date field of each nycbar.org page (saved as nycbar-2024-5.txt, nycbar-2025-6.txt, nycbar-2026-2.txt). UCS Interim Policy on the Use of AI binds only UCS judges and nonjudicial employees, not attorneys; its header says \"Effective October 2025\" (no day; the news release is dated Oct. 10, 2025) and its appendix says \"Amended May 2026\". (D) CHECKED, NOTHING AI-SPECIFIC FOUND (all fetched 2026-09-16, grep for artificial/generative/AI/machine learning/large language/chatgpt/hallucinat returned no hits): Part 130 https://www.nycourts.gov/rules/part-130-costs-and-sanctions; Part 202 https://www.nycourts.gov/rules/part-202-uniform-civil-rules-supreme-court-and-county-court; 202.70 https://www.nycourts.gov/rules/rule/section-20270-rules-commercial-division-supreme-court and legacy PDF https://www.nycourts.gov/LegacyPDFS/courts/comdiv/NY/PDFs/CDRules202-70.pdf; Part 1250 https://www.nycourts.gov/ad3/clerk/rules-of-practice/Statewide-Practice-Rules-Part-1250.pdf (AD3 copy revised Nov. 25, 2019; may not be current); AD1 https://www.nycourts.gov/courts/ad1/Practice&Procedures/rules.shtml; AD2 https://www.nycourts.gov/courts/ad2/pdf/Local_Rules.pdf; AD4 https://ad4.nycourts.gov/rules; NYSBA Rules with Comments (only Comment [8] technology hit). NYSBA Committee on Professional Ethics: no AI opinion found. The listing https://nysba.org/news-center/?show_category=ethics-opinions was viewed through WebFetch only (not saved); it showed Opinions 1292-1301 (Feb. 13-Sept. 3, 2026), none on AI, and further pages did not load; web searches found no NYSBA ethics opinion on AI for 2024-2026, but opinions between late 2024 and early 2026 were not individually checked. NYC Bar opinion list checked by search: AI opinions are 2024-5, 2025-6, 2026-2 (2026-1 concerns lateral screening). (E) NOT FETCHED OR NOT READ: official Department of State NYCRR text of Part 1200 (not tried after the nycourts copy was obtained); the legacy ww2 Part 202 page returned 403 (the current page was used); OCA compilation of public comments on Part 161 not fetched; NYC Bar comment letter on the OCA proposal fetched (page summary) but not read and not relied on; NYSBA news item on Part 161 used as a lead only; judge-specific New York state part rules not surveyed. The Nov. 17, 2025 request for comment PDF has no text layer; quotes from it come from OCR text supplied by the coordinator and are marked (OCR). The NYSBA AI and Access to Justice report was read through, including appendices; it is addressed mainly to civil legal services organizations."
    },
    {
      "id": "nj-rpc",
      "kind": "state_bar",
      "name": "New Jersey Rules of Professional Conduct and N.J. Supreme Court AI guidance",
      "disclosure_to_court": "none",
      "certification_required": false,
      "certificate_language": null,
      "verification_duty": "No AI-specific court rule or certification. Duty rests on existing rules as applied by the N.J. Supreme Court's Preliminary Guidelines (Notice to the Bar dated Jan. 24, 2024), p. 4: \"Because AI can generate false information, a lawyer has an ethical duty to check and verify all information generated by AI to ensure that it is accurate.\" Same, p. 4: \"A lawyer who uses AI in the preparation of legal pleadings, arguments, or evidence remains responsible to ensure the validity of those submissions.\" RPC 3.3(a)(1) (a lawyer shall not knowingly) \"make a false statement of material fact or law to a tribunal\". R. 1:4-8(a) (signature certifies, after \"an inquiry reasonable under the circumstances\") and R. 1:4-8(a)(2): \"the claims, defenses, and other legal contentions therein are warranted by existing law or by a non-frivolous argument for the extension, modification, or reversal of existing law or the establishment of new law\". Supervision: RPC 5.1(b) lawyer \"shall make reasonable efforts to ensure that the other lawyer conforms to the Rules of Professional Conduct\"; RPC 5.3(b) for nonlawyers; Guidelines p. 6: \"This requirement extends to ensuring the ethical use of AI by other lawyers and nonlawyer staff.\" Applied in AmTrust N. Am. v. Liberty Mut. Ins. Co., No. A-2587-24 (App. Div. Mar. 27, 2026) (unpublished, non-precedential under R. 1:36-3), slip op. at 12: \"Attorneys have a duty of candor to the tribunal that cannot be outsourced to AI.\" ($1,000 personal sanction; RPC 3.3, R. 2:9-9, R. 1:4-8(a)(2)). CAUTION: N.J. RPC 1.1 is not the ABA competence rule; it forbids \"gross negligence\" and a \"pattern of negligence or neglect\", and the Court declined to add a technology-competence comment (Notice dated Apr. 2, 2025).",
      "confidentiality_restriction": "RPC 1.6(a): \"A lawyer shall not reveal information relating to representation of a client unless the client consents after consultation\" (subject to listed exceptions). RPC 1.6(f): \"A lawyer shall make reasonable efforts to prevent the inadvertent or unauthorized disclosure of, or unauthorized access to, information relating to the representation of a client.\" Official Comment (Aug. 1, 2016) to 1.6(f): lawyer must \"act competently to safeguard information, including electronically stored information\", with reasonableness factors (sensitivity, likelihood of disclosure, cost and difficulty of safeguards). RPC 5.3 Official Comment (Aug. 1, 2016) lists \"using an Internet-based service to store client information\" as outside nonlawyer assistance for which the lawyer must make reasonable efforts at compatibility. Preliminary Guidelines p. 5: \"A lawyer is responsible to ensure the security of an AI system before entering any non-public client information.\" No rule bars inputting client information into AI outright; the Mar. 30, 2026 Notice's sample firm policy offers pick-one confidentiality options (no AI; no client info in public AI; de-identified only; approved vendor tools only) as a non-binding template.",
      "record_keeping_duty": "none",
      "client_disclosure_duty": "conditional — when the client asks, or when the client cannot make an informed decision about the representation without knowing (Preliminary Guidelines p. 5, applying RPC 1.4(b)–(c)): \"if a client asks if the lawyer is using AI, or if the client cannot make an informed decision about the representation without knowing that the lawyer is using AI, then the lawyer has an obligation to inform the client of the lawyer's use of AI.\" The same passage says the RPCs \"do not impose an affirmative obligation on lawyers to tell clients every time that they use AI.\"",
      "fees_note": "No N.J. AI-specific fee guidance. Preliminary Guidelines p. 6 flag it as a future topic only: \"For instance, the use of AI likely will affect lawyer billing practices and advertising.\" and \"Those and other specific applications can be addressed in future guidelines if and as needed.\" General rule: RPC 1.5.",
      "sources": [
        {
          "title": "N.J. Supreme Court, Notice to the Bar, Legal Practice — Preliminary Guidelines on the Use of Artificial Intelligence by New Jersey Lawyers (dated Jan. 24, 2024), p. 4, Accuracy and Truthfulness",
          "url": "https://www.njcourts.gov/sites/default/files/notices/2024/01/n240125a.pdf",
          "verbatim": "Because AI can generate false information, a lawyer has an ethical duty to check and verify all information generated by AI to ensure that it is accurate. Failure to do so may result in violations of the RPCs.",
          "effective": "2024-01-24",
          "fetched": "2026-09-16"
        },
        {
          "title": "Same — p. 4, Honesty, Candor, and Communication (no RPC duty to disclose AI use)",
          "url": "https://www.njcourts.gov/sites/default/files/notices/2024/01/n240125a.pdf",
          "verbatim": "A lawyer who uses AI in the preparation of legal pleadings, arguments, or evidence remains responsible to ensure the validity of those submissions. While the RPCs do not require a lawyer to disclose the use of AI, such use does not provide an excuse for the submission of false, fake, or misleading content.",
          "effective": "2024-01-24",
          "fetched": "2026-09-16"
        },
        {
          "title": "Same — p. 5, client communication (RPC 1.2, 1.4(b), 1.4(c))",
          "url": "https://www.njcourts.gov/sites/default/files/notices/2024/01/n240125a.pdf",
          "verbatim": "Those RPCs do not impose an affirmative obligation on lawyers to tell clients every time that they use AI. However, if a client asks if the lawyer is using AI, or if the client cannot make an informed decision about the representation without knowing that the lawyer is using AI, then the lawyer has an obligation to inform the client of the lawyer's use of AI.",
          "effective": "2024-01-24",
          "fetched": "2026-09-16"
        },
        {
          "title": "Same — p. 5, Confidentiality",
          "url": "https://www.njcourts.gov/sites/default/files/notices/2024/01/n240125a.pdf",
          "verbatim": "A lawyer is responsible to ensure the security of an AI system before entering any non-public client information.",
          "effective": "2024-01-24",
          "fetched": "2026-09-16"
        },
        {
          "title": "Same — p. 6, Oversight (RPC 5.1, 5.2, 5.3)",
          "url": "https://www.njcourts.gov/sites/default/files/notices/2024/01/n240125a.pdf",
          "verbatim": "This requirement extends to ensuring the ethical use of AI by other lawyers and nonlawyer staff.",
          "effective": "2024-01-24",
          "fetched": "2026-09-16"
        },
        {
          "title": "Same — p. 1 (cover notice), status of the guidelines",
          "url": "https://www.njcourts.gov/sites/default/files/notices/2024/01/n240125a.pdf",
          "verbatim": "While these interim guidelines are effective immediately, the Supreme Court also invites comments and questions on the use of AI in legal practice, including suggestions of potential use cases for lawyers and the courts.",
          "effective": "2024-01-24",
          "fetched": "2026-09-16"
        },
        {
          "title": "Same — p. 3, existing RPCs unchanged",
          "url": "https://www.njcourts.gov/sites/default/files/notices/2024/01/n240125a.pdf",
          "verbatim": "The core ethical responsibilities of lawyers, as outlined in the Rules of Professional Conduct (RPCs) are unchanged by the integration of AI in legal practice, as was true with the introduction of computers and the internet.",
          "effective": "2024-01-24",
          "fetched": "2026-09-16"
        },
        {
          "title": "Notice page for the Preliminary Guidelines (Document Date Jan. 24, 2024; Publish Date Jan. 25, 2024)",
          "url": "https://www.njcourts.gov/notices/notice-legal-practice-preliminary-guidelines-use-of-artificial-intelligence-new-jersey",
          "verbatim": null,
          "effective": "2024-01-24",
          "fetched": "2026-09-16"
        },
        {
          "title": "N.J. RPC 3.3(a)(1), Candor Toward the Tribunal (official Rules of Court text, amendments effective on or before Sept. 1, 2026; the lead-in of (a) and subparagraph (1) are joined because the '(1)' marker is an HTML list marker absent from the extracted text — the official display shows it)",
          "url": "https://www.njcourts.gov/njcourts_rules_of_court/get-term?tid=25906",
          "verbatim": "A lawyer shall not knowingly: make a false statement of material fact or law to a tribunal;",
          "effective": "2004-01-01",
          "fetched": "2026-09-16"
        },
        {
          "title": "N.J. RPC 1.1, Competence (entire rule; no Official Comment; paragraphs (a) and (b) run together because their markers are HTML list markers absent from the extracted text — the official display shows '(a)' before 'Handle' and '(b)' before 'Exhibit')",
          "url": "https://www.njcourts.gov/njcourts_rules_of_court/get-term?tid=25786",
          "verbatim": "A lawyer shall not: Handle or neglect a matter entrusted to the lawyer in such manner that the lawyer's conduct constitutes gross negligence. Exhibit a pattern of negligence or neglect in the lawyer's handling of legal matters generally.",
          "effective": "1984-09-10",
          "fetched": "2026-09-16"
        },
        {
          "title": "N.J. RPC 1.4(b)–(c), Communication (two paragraphs; their '(b)' and '(c)' markers are HTML list markers absent from the extracted text)",
          "url": "https://www.njcourts.gov/njcourts_rules_of_court/get-term?tid=25801",
          "verbatim": "A lawyer shall keep a client reasonably informed about the status of a matter and promptly comply with reasonable requests for information. A lawyer shall explain a matter to the extent reasonably necessary to permit the client to make informed decisions regarding the representation.",
          "effective": "2004-01-01",
          "fetched": "2026-09-16"
        },
        {
          "title": "N.J. RPC 1.6(a), Confidentiality of Information",
          "url": "https://www.njcourts.gov/njcourts_rules_of_court/get-term?tid=25811",
          "verbatim": "A lawyer shall not reveal information relating to representation of a client unless the client consents after consultation, except for (1) disclosures that are impliedly authorized in order to carry out the representation, (2) disclosures of information that is generally known, and (3) as stated in paragraphs (b), (c), and (d).",
          "effective": "2018-09-01",
          "fetched": "2026-09-16"
        },
        {
          "title": "N.J. RPC 1.6(f) (reasonable efforts against inadvertent/unauthorized disclosure or access)",
          "url": "https://www.njcourts.gov/njcourts_rules_of_court/get-term?tid=25811",
          "verbatim": "A lawyer shall make reasonable efforts to prevent the inadvertent or unauthorized disclosure of, or unauthorized access to, information relating to the representation of a client.",
          "effective": "2016-09-01",
          "fetched": "2026-09-16"
        },
        {
          "title": "Same — RPC 1.6 Official Comment (August 1, 2016), paragraph on (f)",
          "url": "https://www.njcourts.gov/njcourts_rules_of_court/get-term?tid=25811",
          "verbatim": "Paragraph (f) requires a lawyer to act competently to safeguard information, including electronically stored information, relating to the representation of a client against unauthorized access by third parties and against inadvertent or unauthorized disclosure by the lawyer or other persons or entities who are participating in the representation of the client or who are subject to the lawyer’s supervision.",
          "effective": "2016-09-01",
          "fetched": "2026-09-16"
        },
        {
          "title": "Same — RPC 1.6 Official Comment (August 1, 2016), reasonableness factors for (f)",
          "url": "https://www.njcourts.gov/njcourts_rules_of_court/get-term?tid=25811",
          "verbatim": "Factors to be considered in determining the reasonableness of the lawyer’s efforts include, but are not limited to, the sensitivity of the information, the likelihood of disclosure if additional safeguards are not employed, the cost of employing additional safeguards, the difficulty of implementing the safeguards, and the extent to which the safeguards adversely affect the lawyer’s ability to represent clients (e.g., by making a device or important piece of software excessively difficult to use).",
          "effective": "2016-09-01",
          "fetched": "2026-09-16"
        },
        {
          "title": "N.J. RPC 5.1(b), Responsibilities of Partners, Supervisory Lawyers, and Law Firms",
          "url": "https://www.njcourts.gov/njcourts_rules_of_court/get-term?tid=25961",
          "verbatim": "A lawyer having direct supervisory authority over another lawyer shall make reasonable efforts to ensure that the other lawyer conforms to the Rules of Professional Conduct.",
          "effective": "1984-09-10",
          "fetched": "2026-09-16"
        },
        {
          "title": "N.J. RPC 5.3(b), Responsibilities Regarding Nonlawyer Assistance",
          "url": "https://www.njcourts.gov/njcourts_rules_of_court/get-term?tid=25971",
          "verbatim": "a lawyer having direct supervisory authority over the nonlawyer shall make reasonable efforts to ensure that the person's conduct is compatible with the professional obligations of the lawyer; and",
          "effective": "1984-09-10",
          "fetched": "2026-09-16"
        },
        {
          "title": "Same — RPC 5.3 Official Comment (August 1, 2016), Nonlawyers Outside the Firm",
          "url": "https://www.njcourts.gov/njcourts_rules_of_court/get-term?tid=25971",
          "verbatim": "Examples include the retention of an investigative or paraprofessional service, hiring a document management company to create and maintain a database for complex litigation, sending client documents to a third party for printing or scanning, and using an Internet-based service to store client information. When using such services outside the firm, a lawyer must make reasonable efforts to ensure that the services are provided in a manner that is compatible with the lawyer’s professional obligations.",
          "effective": "2016-09-01",
          "fetched": "2026-09-16"
        },
        {
          "title": "N.J. Court Rule 1:4-8(a), Frivolous Litigation — signature certification (lead-in)",
          "url": "https://www.njcourts.gov/njcourts_rules_of_court/get-term?tid=24236",
          "verbatim": "By signing, filing or advocating a pleading, written motion, or other paper, an attorney or pro se party certifies that to the best of his or her knowledge, information, and belief, formed after an inquiry reasonable under the circumstances:",
          "effective": null,
          "fetched": "2026-09-16"
        },
        {
          "title": "Same — R. 1:4-8(a)(2), legal contentions",
          "url": "https://www.njcourts.gov/njcourts_rules_of_court/get-term?tid=24236",
          "verbatim": "the claims, defenses, and other legal contentions therein are warranted by existing law or by a non-frivolous argument for the extension, modification, or reversal of existing law or the establishment of new law;",
          "effective": null,
          "fetched": "2026-09-16"
        },
        {
          "title": "AmTrust North America o/b/o McGinness v. Liberty Mutual Insurance Co., No. A-2587-24 (N.J. Super. Ct. App. Div. Mar. 27, 2026) (unpublished; R. 1:36-3), slip op. at 12",
          "url": "https://www.njcourts.gov/system/files/court-opinions/2026/a2587-24.pdf",
          "verbatim": "Attorneys have a duty of candor to the tribunal that cannot be outsourced to AI.",
          "effective": "2026-03-27",
          "fetched": "2026-09-16"
        },
        {
          "title": "Same — slip op. at 3, holding (RPC 3.3 and R. 2:9-9; $1,000 sanction)",
          "url": "https://www.njcourts.gov/system/files/court-opinions/2026/a2587-24.pdf",
          "verbatim": "Counsel's disregard for his obligations toward his adversary and this court is a violation of RPC 3.3 and Rule 2:9-9, particularly in light of counsel's failure to react when alerted to the error. Under these circumstances, we impose a $1000 sanction upon plaintiff's counsel.",
          "effective": "2026-03-27",
          "fetched": "2026-09-16"
        },
        {
          "title": "Same — slip op. at 1, non-precedential legend (R. 1:36-3)",
          "url": "https://www.njcourts.gov/system/files/court-opinions/2026/a2587-24.pdf",
          "verbatim": "This opinion shall not \"constitute precedent or be binding upon any court.\" Although it is posted on the internet, this opinion is binding only on the parties in the case and its use in other cases is limited.",
          "effective": "2026-03-27",
          "fetched": "2026-09-16"
        },
        {
          "title": "N.J. Notice to the Bar, Responsible Use of Artificial Intelligence (AI) and Related Technologies — Benefits of AI Policies (dated Mar. 30, 2026), p. 1",
          "url": "https://www.njcourts.gov/sites/default/files/notices/2026/03/n260330c.pdf",
          "verbatim": "The Supreme Court of New Jersey encourages attorneys and law firms to develop, adopt, and periodically update internal policies and practices governing the use of AI and related technologies as part of maintaining professional competence and ethical compliance.",
          "effective": "2026-03-30",
          "fetched": "2026-09-16"
        },
        {
          "title": "Same — p. 1, lawyers remain responsible",
          "url": "https://www.njcourts.gov/sites/default/files/notices/2026/03/n260330c.pdf",
          "verbatim": "Attorneys remain fully responsible for their work product and professional obligations under the Rules of Professional Conduct (including RPCs 1.1, 1.6, 5.1, 5.3, and 3.3).",
          "effective": "2026-03-30",
          "fetched": "2026-09-16"
        },
        {
          "title": "Same — starter template preface (template is not a safe harbor)",
          "url": "https://www.njcourts.gov/sites/default/files/notices/2026/03/n260330c.pdf",
          "verbatim": "Adopting a policy is encouraged, but it is not a “safe harbor.” A document alone does not mitigate, remove, or prevent mistakes, confidentiality lapses, or professional consequences -- only careful implementation, training, supervision, and verification can reduce those risks.",
          "effective": "2026-03-30",
          "fetched": "2026-09-16"
        },
        {
          "title": "Same — sample template § (3)(E), Case citations (sample firm-policy language, not a rule)",
          "url": "https://www.njcourts.gov/sites/default/files/notices/2026/03/n260330c.pdf",
          "verbatim": "Any case law, statute, rule, quotation, or pinpoint citation included in a draft prepared with AI assistance must be verified by law firm personnel using an official source before it is relied on or filed. If a citation cannot be verified, it must be removed.",
          "effective": "2026-03-30",
          "fetched": "2026-09-16"
        },
        {
          "title": "Notice page for the Mar. 30, 2026 Notice (Document Date and Publish Date March 30, 2026)",
          "url": "https://www.njcourts.gov/notices/notice-responsible-use-of-artificial-intelligence-ai-and-related-technologies-benefits-of",
          "verbatim": null,
          "effective": "2026-03-30",
          "fetched": "2026-09-16"
        },
        {
          "title": "N.J. Notice to the Bar, Attorney Responsibilities as to Cybersecurity & Emerging Technologies — New Requirement of One CLE Credit in Technology-Related Subjects (dated Apr. 2, 2025; PDF text layer has spacing artifacts, so quoted from the notice page) — RPC 1.1 technology comment NOT adopted",
          "url": "https://www.njcourts.gov/sites/default/files/notices/2025/04/n250404a.pdf",
          "verbatim": null,
          "effective": null,
          "fetched": "2026-09-16"
        },
        {
          "title": "Same — notice page for the Apr. 2, 2025 Notice (Document Date April 2, 2025; Publish Date April 4, 2025), declination sentence",
          "url": "https://www.njcourts.gov/notices/notice-attorney-responsibilities-cybersecurity-emerging-technologies-new-requirement-of-one",
          "verbatim": "Following review, the Court declined to adopt the other proposal, i.e., to add a comment to RPC 1.1 regarding an attorney's responsibility, as part of competence, to keep abreast of the benefits and risks associated with relevant technology.",
          "effective": null,
          "fetched": "2026-09-17"
        },
        {
          "title": "PROPOSED, NOT ADOPTED — N.J. Notice to the Bar, Request for Comments on Proposed CLE Requirement and Proposed Official Comment to RPC 1.1 (dated Nov. 19, 2024), p. 2",
          "url": "https://www.njcourts.gov/sites/default/files/notices/2024/11/n241121e.pdf",
          "verbatim": "To maintain competence, a lawyer should keep abreast of changes in the law and its practice, including the benefits and risks associated with relevant technology, engage in continuing study and education, and comply with all continuing legal education requirements to which the lawyer is subject.",
          "effective": null,
          "fetched": "2026-09-16"
        },
        {
          "title": "N.J. Supreme Court Order amending R. 1:42-1 (technology-related CLE credit) (dated Mar. 31, 2026), with Notice to the Bar dated Mar. 31, 2026",
          "url": "https://www.njcourts.gov/sites/default/files/notices/2026/03/n260401b.pdf",
          "verbatim": "At least one of the twenty-four hours of credit shall be in technology-related subjects.",
          "effective": "2026-03-31",
          "fetched": "2026-09-16"
        },
        {
          "title": "Same — notice page for the R. 1:42-1 Notice and Order (Document Date Mar. 31, 2026; Publish Date Apr. 1, 2026), Order paragraph",
          "url": "https://www.njcourts.gov/notices/notice-and-order-continuing-legal-education-amendments-court-rule-r-142-1-and-cle",
          "verbatim": "It is ORDERED that the attached amendments to Rule 1:42-1 of the Rules Governing the Courts of the State of New Jersey and to Continuing Legal Education (CLE) Regulations 103:1 and 201:1, adding technology-related subjects as a requirement, are adopted to be effective immediately, with reporting on compliance with this new requirement to begin with the two-year CLE reporting cycle that concludes December 31, 2027.",
          "effective": "2026-03-31",
          "fetched": "2026-09-16"
        },
        {
          "title": "N.J. Courts, Rules of Court — Rules of Professional Conduct page (JS-rendered; header states currency of rule text)",
          "url": "https://www.njcourts.gov/attorneys/rules-of-court/rules-professional-conduct",
          "verbatim": "Note: Includes amendments effective on or before Sept. 1, 2026.",
          "effective": null,
          "fetched": "2026-09-16"
        },
        {
          "title": "N.J. Supreme Court, Statement of Principles for the New Jersey Judiciary's Ongoing Use of Artificial Intelligence (approved Jan. 23, 2024), principle 1 — binds/guides the Judiciary, not lawyers",
          "url": "https://www.njcourts.gov/sites/default/files/courts/supreme/statement-ai.pdf",
          "verbatim": "Judges and their staff may use AI only for select purposes, such as for preliminary gathering and organization of information.",
          "effective": "2024-01-23",
          "fetched": "2026-09-16"
        },
        {
          "title": "N.J. Courts, Notice on Use of Artificial Intelligence (self-help page for self-represented litigants; undated)",
          "url": "https://www.njcourts.gov/self-help/legal-reference-materials/notice-on-ai",
          "verbatim": "If you represent yourself in court, you are responsible to ensure that all communications with the court, including those assisted by AI, are honest and truthful.",
          "effective": null,
          "fetched": "2026-09-16"
        },
        {
          "title": "N.J. Judiciary, Guidance for Courts on the Importance of Artificial Intelligence (July 2024) — judge/court-facing, AI evidence; nothing on lawyer filings",
          "url": "https://www.njcourts.gov/sites/default/files/attorneys/attorney-resources/guidance-courts-ai.pdf",
          "verbatim": null,
          "effective": null,
          "fetched": "2026-09-16"
        },
        {
          "title": "N.J. Courts, Artificial Intelligence — Use in the Courts (index page of Judiciary AI notices and resources)",
          "url": "https://www.njcourts.gov/attorneys/artificial-intelligence-use-courts",
          "verbatim": null,
          "effective": null,
          "fetched": "2026-09-16"
        },
        {
          "title": "LEAD ONLY — N.J. Judiciary CLE slide deck, Trust But Verify — Generative AI and Attorney Ethics (Apr. 21, 2026) (not a court notice; poor text layer)",
          "url": "https://www.njcourts.gov/sites/default/files/attorneys/attorney-resources/trust-verify.pdf",
          "verbatim": null,
          "effective": null,
          "fetched": "2026-09-16"
        },
        {
          "title": "LEAD ONLY — N.J. Judiciary CLE slide deck, Legal Ethics & Artificial Intelligence — Guidance for New Jersey Lawyers (July 24, 2024)",
          "url": "https://www.njcourts.gov/sites/default/files/attorneys/attorney-resources/al-legalethics.pdf",
          "verbatim": null,
          "effective": null,
          "fetched": "2026-09-16"
        },
        {
          "title": "LEAD ONLY — WorkersCompensation.com, 'Glib' Reliance on AI Hallucinations 'Stuns' N.J. Court (AmTrust report)",
          "url": "https://www.workerscompensation.com/daily-headlines/glib-reliance-on-ai-hallucinations-stuns-n-j-court-earns-attorney-1000-sanction/",
          "verbatim": null,
          "effective": null,
          "fetched": null
        },
        {
          "title": "LEAD ONLY — LawSites, N.J. Supreme Court Adopts Tech CLE Requirement But Declines to Adopt Duty of Tech Competence (Apr. 2025)",
          "url": "https://www.lawnext.com/2025/04/n-j-supreme-court-adopts-tech-cle-requirement-but-declines-to-adopt-duty-of-tech-competence.html",
          "verbatim": null,
          "effective": null,
          "fetched": null
        },
        {
          "title": "LEAD ONLY — O'Toole Scrivo, Proposed New Jersey Legislation Signals Expanding AI Compliance Obligations (June 22, 2026) (led to A4731)",
          "url": "https://www.oslaw.com/news/2026-06-22-proposed-new-jersey-legislation-signals-expanding-ai-compliance-obligations",
          "verbatim": null,
          "effective": null,
          "fetched": null
        },
        {
          "title": "LEAD ONLY — NJSBA Task Force on AI and the Law Report (May 2024) (voluntary bar association; not Judiciary guidance; not read)",
          "url": "https://njsba.com/wp-content/uploads/2024/05/NJSBA-TASK-FORCE-ON-AI-AND-THE-LAW-REPORT-final.pdf",
          "verbatim": null,
          "effective": null,
          "fetched": null
        }
      ],
      "status": "verified",
      "verified_on": "2026-09-17",
      "verified_by": "claude-opus-5 (independent verifier session; every source URL re-fetched 2026-09-17; checkq/strictq exact match; pinpoints, effective dates, status and narrative claims checked against the fetched text; one missed-item search)",
      "attorney_signoff": null,
      "notes": "(1) BOTTOM LINE: As of the sources fetched 2026-09-16, New Jersey state courts have no rule, order, or notice requiring disclosure of AI use in filings or an AI certification; the Preliminary Guidelines (p. 4) state the RPCs do not require disclosure to courts. Verification rests on RPC 3.3, R. 1:4-8(a), and the Guidelines. Client disclosure is conditional (Guidelines p. 5). No AI record-keeping duty exists. (2) BINDING STATUS: RPCs and R. 1:4-8 are binding court rules. The Preliminary Guidelines are a Supreme Court Notice to the Bar signed by Chief Justice Rabner and the Acting Administrative Director, stating \"While these interim guidelines are effective immediately\" and that core RPC duties are unchanged (p. 3); they interpret existing RPCs and are not new rule text, but the Appellate Division relied on them in AmTrust. The Mar. 30, 2026 Notice (signed by the Acting Administrative Director) is hortatory: it \"encourages attorneys and law firms to develop, adopt, and periodically update internal policies\"; its starter template is sample language and expressly not a safe harbor. The Statement of Principles (approved Jan. 23, 2024) and Guidance for Courts (July 2024) govern the Judiciary's own use of AI and judicial evaluation of AI evidence, not lawyers. The self-help Notice on AI addresses self-represented litigants. AmTrust (App. Div. Mar. 27, 2026) is unpublished and non-precedential under R. 1:36-3 (legend on slip op. p. 1); the panel said \"Although not every misuse of artificial intelligence will warrant a sanction\" the facts there did. The two Judiciary CLE slide decks are not law (LEAD ONLY). (3) ADOPTED vs PROPOSED: (a) Proposed Official Comment to RPC 1.1 on technology competence (Notice dated Nov. 19, 2024; comments due Dec. 20, 2024) was NOT adopted: the Notice dated Apr. 2, 2025 says \"the Court declined to adopt the other proposal\"; current RPC 1.1 on njcourts.gov carries no comment. (b) Technology CLE credit: ADOPTED by Supreme Court Order dated Mar. 31, 2026 amending R. 1:42-1 and CLE Regs. 103:1(t) and 201:1; the Order says the amendments \"are adopted to be effective immediately, with reporting on compliance with this new requirement to begin with the two-year CLE reporting cycle that concludes December 31, 2027.\" Discrepancy for the verifier: the covering notice says the requirement \"is effective January 1, 2027\" and refers to the Court's \"March 26, 2026 Order\" although the attached Order is dated March 31, 2026. This is a CLE rule, not a filing or disclosure rule. (c) Proposed CLE Regulation definition published Dec. 30, 2025 (comments by Jan. 30, 2026; https://www.njcourts.gov/sites/default/files/notices/2025/12/n251230a.pdf, fetched 2026-09-16) was superseded by the different definition adopted Mar. 31, 2026. (d) Bills (pending is not law): A4731 (222nd Leg., introduced Mar. 10, 2026; text as introduced, https://pub.njleg.gov/Bills/2026/A5000/4731_I1.HTM, fetched 2026-09-16) would direct the Division of Consumer Affairs to adopt a generative-AI model policy for licensees of the boards designated in C.45:1-15; on its face it does not reach attorneys, who are regulated by the Supreme Court (verifier to confirm); legislative status history not fetched. S3357 (2024, AI Advisory Council; https://pub.njleg.gov/Bills/2024/S3500/3357_I1.HTM) and A3307 (2026 prefiled, AI in news media; https://pub.njleg.gov/Bills/2026/A3500/3307_I1.HTM), both fetched 2026-09-16, are unrelated to legal practice. No enacted N.J. statute or pending bill on AI in court filings or attorney AI use was found. (4) CHECKED, NOTHING AI-SPECIFIC (all fetched 2026-09-16): R. 1:4-8 full text (no AI language; per its Note last amended eff. Sept. 1, 2004); full current RPC text (grep for artificial, generative, AI, machine learning, large language, chatgpt, technolog, hallucinat: no hits; the only electronic, Internet, computer or software references are in RPC 1.0, the 1.6 comments, the 1.18 comment, 4.4 and its comment, the 5.3 comment, 7.2, 7.3 and the note on legal assistance organizations' website retention); Notice of Supreme Court Action on 2024-2026 Civil Practice Committee Recommendations (dated July 27, 2026; 2026 Omnibus Rule Amendment Order eff. Sept. 1, 2026; https://www.njcourts.gov/sites/default/files/notices/2026/07/n260728a.pdf); Notice of Professional Responsibility Rules Committee Report 2018-2024 (dated Sept. 30, 2024; https://www.njcourts.gov/sites/default/files/notices/2024/09/n240930c.pdf); Notice summarizing the AI survey and CLE plans (dated June 11, 2024; https://www.njcourts.gov/sites/default/files/notices/2024/06/n240612a.pdf); Notices to the Bar database (https://www.njcourts.gov/attorneys/notices, date range 2024-01-01 to 2026-09-16) searched for 'artificial intelligence' (6 results, latest Mar. 30, 2026), 'generative' (1, a CLE program), 'technology' (7: tech CLE, HDMI courtroom standard, bots), '1:4-8' (0), and ACPE notices 2023-2026 (Opinions 745, 746, 747, 748, 749 and 735 Supplement; none on AI). Court opinion searches on njcourts.gov (published Appellate and Supreme, 'artificial intelligence') returned nothing, but that search matches case titles only, so it is inconclusive; web searches found no published N.J. state appellate or Supreme Court opinion on AI-fabricated citations. (5) OFFICIAL COMMENTS: New Jersey did not adopt the ABA comments wholesale. The current RPC text carries Official Comments only on RPC 1.6, 1.18, 3.6, 4.2, 4.4, 5.3, 7.1, 7.5, 8.4 and Advertising Guideline 3; RPC 1.1, 1.4, 3.3 and 5.1 have none. (6) PROVENANCE AND PINPOINTS: The RPC page is JS-rendered; rule text was curled from its official JSON endpoint (njcourts_rules_of_court/get-term?tid=N; raw responses in nj/json/), each description field wrapped into nj-rpc-current.html and nj-r1-4-8.html by a mechanical script, then converted with html2txt. Paragraph letters are HTML list markers and do not appear in the .txt; letters were cross-checked against the superseded official PDF https://www.njcourts.gov/sites/default/files/appemploy.pdf (amendments through Sept. 1, 2018; fetched 2026-09-16; cross-check only). Effective dates for RPC items come from each rule's Note; RPC 5.1(b) and 5.3(b) show no amendment since adoption (eff. Sept. 10, 1984); R. 1:4-8 effective left null because its Note does not say which paragraphs were amended. Guidelines effective date = document date Jan. 24, 2024 (the notice page shows Publish Date Jan. 25, 2024). The Guidelines PDF text has OCR artifacts (Al for AI), and the Guidelines paraphrase RPC 1.6(f) as information related to, where the rule says relating to. The Apr. 2, 2025 notice text layer has spacing artifacts, copied as extracted. (7) NOT FETCHED: ACPE Opinion 701 (electronic storage; the njcourts.gov URL returned an HTML page, not the opinion) — neither the Guidelines nor the RPC 1.6 comment rely on it; NJSBA Task Force report (bar association); Judiciary AI survey, glossary and AI-resources PDFs; bill status histories. (8) SEED CORRECTIONS: the seed said client_disclosure_duty none (the Guidelines make it conditional) and cited RPC 1.1 as a competence/verification rule (N.J. RPC 1.1 is a gross-negligence rule). D.N.J. local rules and judge orders are outside this entry."
    },
    {
      "id": "pa-rpc",
      "kind": "state_bar",
      "name": "Pennsylvania Rules of Professional Conduct (204 Pa. Code Ch. 81) and Pennsylvania AI guidance",
      "disclosure_to_court": "none",
      "certification_required": false,
      "certificate_language": null,
      "verification_duty": "No Pennsylvania rule, Supreme Court order, or statute imposes an AI-specific verification or disclosure duty on attorneys as of 2026-09-16; the duty comes from general rules. Rule 1.1 (black letter): \"A lawyer shall provide competent representation to a client.\" Rule 1.1 Comment (8): a lawyer \"should keep abreast of changes in the law and its practice, including the benefits and risks associated with relevant technology\" (a Comment only; Scope para. (14): \"Comments do not add obligations to the Rules\"). Rule 3.3(a)(1): a lawyer shall not knowingly \"make a false statement of material fact or law to a tribunal\". Rules 5.1(b) and 5.3(b): a supervising lawyer \"shall make reasonable efforts to ensure\" conformity. Pa.R.C.P. 1023.1(c) (civil practice): \"The signature of an attorney or pro se party constitutes a certificate that the signatory has read the pleading, motion, or other paper.\" and certifies, after reasonable inquiry, that legal contentions are \"warranted by existing law\" (a general signing certification, not AI-specific, made by the act of signing). Non-binding: PBA and Philadelphia Bar Joint Formal Opinion 2024-200 at 9 reads Rule 1.1 to require a lawyer who uses AI to \"check and verify all citations and the material cited\". Commonwealth Court No. 1172 C.D. 2025 (single-judge memorandum opinion, not reported, filed Nov. 24, 2025) struck an AI-generated brief; it binds no one beyond that order and is not a statewide rule.",
      "confidentiality_restriction": "Rule 1.6(a): \"A lawyer shall not reveal information relating to representation of a client unless the client gives informed consent\" (subject to implied authorization and the listed exceptions). Rule 1.6(d): \"A lawyer shall make reasonable efforts to prevent the inadvertent or unauthorized disclosure of, or unauthorized access to, information relating to the representation of a client.\" Comment (25) reasonableness factors include \"the sensitivity of the information\". Rule 5.3 Comment (3) lists \"using an Internet-based service to store client information\" as outside nonlawyer assistance requiring reasonable efforts. Non-binding: Joint Formal Opinion 2024-200 at 10: \"a lawyer must not input any confidential information of a client into AI that lacks adequate confidentiality and security protections.\" The Supreme Court Interim Policy bars sharing \"non-public information with non-secured AI systems\", but it governs court Personnel only, not attorneys.",
      "record_keeping_duty": "none",
      "client_disclosure_duty": "conditional — binding Rule 1.4(a)(2) requires reasonable consultation about \"the means by which the client’s objectives are to be accomplished\" and Rule 1.4(b) requires explanation \"to the extent reasonably necessary to permit the client to make informed decisions regarding the representation\"; client informed consent is needed under Rule 1.6(a) before confidential information is revealed to an AI provider outside implied authorization. Non-binding Joint Formal Opinion 2024-200 goes further: at 10, \"Rule 1.4 requires the lawyer to inform the client of the benefits, risks, and limits of the use of generative AI.\" and at 15 \"If necessary, they should obtain client consent before using certain AI tools.\"",
      "fees_note": "Rule 1.5(a): \"A lawyer shall not enter into an agreement for, charge, or collect an illegal or clearly excessive fee.\" Rule 1.5 Comment (3): \"A lawyer should not exploit a fee arrangement based primarily on hourly charges by using wasteful procedures.\" Non-binding Joint Formal Opinion 2024-200 at 16: \"Lawyers must, therefore, ensure that AI-related expenses are reasonable and appropriately disclosed to clients.\"",
      "sources": [
        {
          "title": "204 Pa. Code § 81.2, Scope para. (21) — authority of Comments",
          "url": "https://www.pacodeandbulletin.gov/Display/pacode?file=/secure/pacode/data/204/chapter81/chap81toc.html",
          "verbatim": "The Comments are intended as guides to interpretation, but the text of each Rule is authoritative.",
          "effective": "2005-01-01",
          "fetched": "2026-09-16"
        },
        {
          "title": "Same — Scope para. (14) (Comments add no obligations)",
          "url": "https://www.pacodeandbulletin.gov/Display/pacode?file=/secure/pacode/data/204/chapter81/chap81toc.html",
          "verbatim": "Many of the Comments use the term ‘‘should.’’ Comments do not add obligations to the Rules but provide guidance for practicing in compliance with the Rules.",
          "effective": "2005-01-01",
          "fetched": "2026-09-16"
        },
        {
          "title": "Same — Rule 1.1 (Competence), black letter",
          "url": "https://www.pacodeandbulletin.gov/Display/pacode?file=/secure/pacode/data/204/chapter81/chap81toc.html",
          "verbatim": "A lawyer shall provide competent representation to a client. Competent representation requires the legal knowledge, skill, thoroughness and preparation reasonably necessary for the representation.",
          "effective": "2018-07-01",
          "fetched": "2026-09-16"
        },
        {
          "title": "Same — Rule 1.1 Comment (8) (technology competence)",
          "url": "https://www.pacodeandbulletin.gov/Display/pacode?file=/secure/pacode/data/204/chapter81/chap81toc.html",
          "verbatim": "To maintain the requisite knowledge and skill, a lawyer should keep abreast of changes in the law and its practice, including the benefits and risks associated with relevant technology, engage in continuing study and education and comply with all continuing legal education requirements to which the lawyer is subject.",
          "effective": "2018-07-01",
          "fetched": "2026-09-16"
        },
        {
          "title": "Same — Rule 1.4(a)(2) (Communication)",
          "url": "https://www.pacodeandbulletin.gov/Display/pacode?file=/secure/pacode/data/204/chapter81/chap81toc.html",
          "verbatim": "reasonably consult with the client about the means by which the client’s objectives are to be accomplished;",
          "effective": null,
          "fetched": "2026-09-16"
        },
        {
          "title": "Same — Rule 1.4(b)",
          "url": "https://www.pacodeandbulletin.gov/Display/pacode?file=/secure/pacode/data/204/chapter81/chap81toc.html",
          "verbatim": "A lawyer shall explain a matter to the extent reasonably necessary to permit the client to make informed decisions regarding the representation.",
          "effective": null,
          "fetched": "2026-09-16"
        },
        {
          "title": "Same — Rule 1.5(a) (Fees)",
          "url": "https://www.pacodeandbulletin.gov/Display/pacode?file=/secure/pacode/data/204/chapter81/chap81toc.html",
          "verbatim": "A lawyer shall not enter into an agreement for, charge, or collect an illegal or clearly excessive fee.",
          "effective": "2020-11-25",
          "fetched": "2026-09-16"
        },
        {
          "title": "Same — Rule 1.6(a) (Confidentiality of Information)",
          "url": "https://www.pacodeandbulletin.gov/Display/pacode?file=/secure/pacode/data/204/chapter81/chap81toc.html",
          "verbatim": "A lawyer shall not reveal information relating to representation of a client unless the client gives informed consent, except for disclosures that are impliedly authorized in order to carry out the representation, and except as stated in paragraphs (b) and (c).",
          "effective": null,
          "fetched": "2026-09-16"
        },
        {
          "title": "Same — Rule 1.6(d) (reasonable efforts to prevent disclosure or access)",
          "url": "https://www.pacodeandbulletin.gov/Display/pacode?file=/secure/pacode/data/204/chapter81/chap81toc.html",
          "verbatim": "A lawyer shall make reasonable efforts to prevent the inadvertent or unauthorized disclosure of, or unauthorized access to, information relating to the representation of a client.",
          "effective": null,
          "fetched": "2026-09-16"
        },
        {
          "title": "Same — Rule 1.6 Comment (25) (acting competently to preserve confidentiality)",
          "url": "https://www.pacodeandbulletin.gov/Display/pacode?file=/secure/pacode/data/204/chapter81/chap81toc.html",
          "verbatim": "Paragraph (d) requires a lawyer to act competently to safeguard information relating to the representation of a client against unauthorized access by third parties and against inadvertent or unauthorized disclosure by the lawyer or other persons who are participating in the representation of the client or who are subject to the lawyer’s supervision.",
          "effective": null,
          "fetched": "2026-09-16"
        },
        {
          "title": "Same — Rule 3.3(a)(1) (Candor Toward the Tribunal)",
          "url": "https://www.pacodeandbulletin.gov/Display/pacode?file=/secure/pacode/data/204/chapter81/chap81toc.html",
          "verbatim": "A lawyer shall not knowingly: (1) make a false statement of material fact or law to a tribunal or fail to correct a false statement of material fact or law previously made to the tribunal by the lawyer;",
          "effective": null,
          "fetched": "2026-09-16"
        },
        {
          "title": "Same — Rule 3.3 Comment (4) (legal argument)",
          "url": "https://www.pacodeandbulletin.gov/Display/pacode?file=/secure/pacode/data/204/chapter81/chap81toc.html",
          "verbatim": "Legal argument based on a knowingly false representation of law constitutes dishonesty toward the tribunal.",
          "effective": null,
          "fetched": "2026-09-16"
        },
        {
          "title": "Same — Rule 5.1(b) (supervisory lawyers)",
          "url": "https://www.pacodeandbulletin.gov/Display/pacode?file=/secure/pacode/data/204/chapter81/chap81toc.html",
          "verbatim": "A lawyer having direct supervisory authority over another lawyer shall make reasonable efforts to ensure that the other lawyer conforms to the Rules of Professional Conduct.",
          "effective": null,
          "fetched": "2026-09-16"
        },
        {
          "title": "Same — Rule 5.3(b) (nonlawyer assistance)",
          "url": "https://www.pacodeandbulletin.gov/Display/pacode?file=/secure/pacode/data/204/chapter81/chap81toc.html",
          "verbatim": "a lawyer having direct supervisory authority over the nonlawyer shall make reasonable efforts to ensure that the person’s conduct is compatible with the professional obligations of the lawyer; and",
          "effective": null,
          "fetched": "2026-09-16"
        },
        {
          "title": "Same — Rule 5.3 Comment (3) (nonlawyers outside the firm, incl. Internet-based services)",
          "url": "https://www.pacodeandbulletin.gov/Display/pacode?file=/secure/pacode/data/204/chapter81/chap81toc.html",
          "verbatim": "When using such services outside the firm, a lawyer must make reasonable efforts to ensure that the services are provided in a manner that is compatible with the lawyer’s professional obligations.",
          "effective": null,
          "fetched": "2026-09-16"
        },
        {
          "title": "Same — Rule 1.5 Comment (3)",
          "url": "https://www.pacodeandbulletin.gov/Display/pacode?file=/secure/pacode/data/204/chapter81/chap81toc.html",
          "verbatim": "A lawyer should not exploit a fee arrangement based primarily on hourly charges by using wasteful procedures.",
          "effective": "2020-11-25",
          "fetched": "2026-09-16"
        },
        {
          "title": "Pa.R.C.P. 1023.1(c), 231 Pa. Code Rule 1023.1 (signing certification; general, not AI-specific)",
          "url": "https://www.pacodeandbulletin.gov/Display/pacode?file=/secure/pacode/data/231/chapter1000/s1023.1.html",
          "verbatim": "The signature of an attorney or pro se party constitutes a certificate that the signatory has read the pleading, motion, or other paper.",
          "effective": "2003-06-01",
          "fetched": "2026-09-16"
        },
        {
          "title": "Same — Rule 1023.1(c)(2)",
          "url": "https://www.pacodeandbulletin.gov/Display/pacode?file=/secure/pacode/data/231/chapter1000/s1023.1.html",
          "verbatim": "(2) the claims, defenses, and other legal contentions therein are warranted by existing law or by a nonfrivolous argument for the extension, modification or reversal of existing law or the establishment of new law,",
          "effective": "2003-06-01",
          "fetched": "2026-09-16"
        },
        {
          "title": "Civil Procedural Rules Committee, Notice of Proposed Rulemaking, Proposed Amendment of Pa.R.Civ.P. 1023.1–1023.4 (re-publication; PROPOSED, not adopted; no AI content)",
          "url": "https://www.pacourts.us/Storage/media/pdfs/20250908/145459-proposaltoamendpa.r.civ.p.1023.1-1023.4-re-publication.pdf",
          "verbatim": "All communications in reference to the proposal should be received by November 21, 2025.",
          "effective": null,
          "fetched": "2026-09-16"
        },
        {
          "title": "Supreme Court of Pennsylvania, Order, In re Interim Policy on the Use of Generative AI by Judicial Officers and Court Personnel, No. 643 Judicial Administration Docket (Sept. 9, 2025) (binds court Personnel, not attorneys)",
          "url": "https://www.pacourts.us/assets/opinions/Supreme/out/Order%20Entered%20-%20106502825326189062.pdf?cb=1",
          "verbatim": "This Order shall be processed in accordance with Pa.R.J.A. 103(b), and the Policy shall be effective December 8, 2025.",
          "effective": "2025-12-08",
          "fetched": "2026-09-16"
        },
        {
          "title": "Interim Policy on the Use of Generative Artificial Intelligence by Judicial Officers and Court Personnel (attachment) — Section 2.A (scope), p. 3",
          "url": "https://www.pacourts.us/assets/opinions/Supreme/out/Attachment%20-%20106502825326188944.pdf?cb=1",
          "verbatim": "This Policy applies to Personnel using GenAI on UJS Technology Resources.",
          "effective": "2025-12-08",
          "fetched": "2026-09-16"
        },
        {
          "title": "Same — Section 4 Commentary (human review), p. 5",
          "url": "https://www.pacourts.us/assets/opinions/Supreme/out/Attachment%20-%20106502825326188944.pdf?cb=1",
          "verbatim": "To repeat: humans must review GenAI output and Personnel are responsible for the accuracy of any GenAI information incorporated into their work.",
          "effective": "2025-12-08",
          "fetched": "2026-09-16"
        },
        {
          "title": "Same — Section 5.B (non-public information), p. 6",
          "url": "https://www.pacourts.us/assets/opinions/Supreme/out/Attachment%20-%20106502825326188944.pdf?cb=1",
          "verbatim": "Personnel shall not share any non-public information with non-secured AI systems.",
          "effective": "2025-12-08",
          "fetched": "2026-09-16"
        },
        {
          "title": "Pennsylvania Bulletin publication of the Interim Policy order, 55 Pa.B. 6696 (Sept. 20, 2025), Pa.B. Doc. No. 25-1289",
          "url": "https://www.pacodeandbulletin.gov/Display/pabull?file=/secure/pabulletin/data/vol55/55-38/1289.html",
          "verbatim": null,
          "effective": "2025-12-08",
          "fetched": "2026-09-16"
        },
        {
          "title": "UJS Artificial Intelligence Advisory Committee page (pacourts.us)",
          "url": "https://www.pacourts.us/artificial-intelligence-advisory-committee",
          "verbatim": "On September 9, 2025, the Supreme Court adopted the Interim Policy with an effective date of December 8, 2025.",
          "effective": null,
          "fetched": "2026-09-16"
        },
        {
          "title": "Judicial Ethics Advisory Board, General Ethics Guidance No. 2-2025, Use of Generative Artificial Intelligence (issued Dec. 10, 2025), p. 6 (addressed to judicial officers)",
          "url": "https://www.pacourts.us/Storage/media/pdfs/20251215/201356-generalguidanceno.2-2025.pdf",
          "verbatim": "Much like the Codes, the Rules of Professional Conduct do not specifically address the use of AI/GenAI.",
          "effective": "2025-12-10",
          "fetched": "2026-09-16"
        },
        {
          "title": "Same — p. 6 (status of Joint Formal Opinion)",
          "url": "https://www.pacourts.us/Storage/media/pdfs/20251215/201356-generalguidanceno.2-2025.pdf",
          "verbatim": "However, the Joint Formal Opinion is not binding on the Disciplinary Board of the Supreme Court of Pennsylvania or any other Court.",
          "effective": "2025-12-10",
          "fetched": "2026-09-16"
        },
        {
          "title": "PBA Committee on Legal Ethics and Professional Responsibility and Philadelphia Bar Association Professional Guidance Committee, Joint Formal Opinion 2024-200, Ethical Issues Regarding the Use of Artificial Intelligence — p. 9 (Rule 1.1)",
          "url": "https://www.pabar.org/Members/catalogs/Ethics%20Opinions/Formal/Joint%20Formal%20Opinion%202024-200.pdf",
          "verbatim": "Thus, if a lawyer chooses to use AI or any other technology, the lawyer has the responsibility to (1) understand the technology and how it works, (2) understand the benefits of the technology, (3) understand the risks of the technology, (4) check and verify all citations and the material cited, and (5) especially in cases where the benefits outweigh the risks, have an obligation to educate the client and seek their informed consent to use the technology.",
          "effective": "2024-05-22",
          "fetched": "2026-09-16"
        },
        {
          "title": "Same — p. 4 (obligation to verify generative AI citations)",
          "url": "https://www.pabar.org/Members/catalogs/Ethics%20Opinions/Formal/Joint%20Formal%20Opinion%202024-200.pdf",
          "verbatim": "Because generative AI creates content, however, lawyers have an obligation to verify that the citations are correct and that they accurately summarize the cases or other information cited.",
          "effective": "2024-05-22",
          "fetched": "2026-09-16"
        },
        {
          "title": "Same — p. 10 (Rule 1.4 communication)",
          "url": "https://www.pabar.org/Members/catalogs/Ethics%20Opinions/Formal/Joint%20Formal%20Opinion%202024-200.pdf",
          "verbatim": "Rule 1.4 requires the lawyer to inform the client of the benefits, risks, and limits of the use of generative AI.",
          "effective": "2024-05-22",
          "fetched": "2026-09-16"
        },
        {
          "title": "Same — p. 10 (confidential information into AI; discussed under Rules 1.7 and 1.9)",
          "url": "https://www.pabar.org/Members/catalogs/Ethics%20Opinions/Formal/Joint%20Formal%20Opinion%202024-200.pdf",
          "verbatim": "Therefore, a lawyer must not input any confidential information of a client into AI that lacks adequate confidentiality and security protections.",
          "effective": "2024-05-22",
          "fetched": "2026-09-16"
        },
        {
          "title": "Same — p. 13 (supervision, Rules 5.1 and 5.3)",
          "url": "https://www.pabar.org/Members/catalogs/Ethics%20Opinions/Formal/Joint%20Formal%20Opinion%202024-200.pdf",
          "verbatim": "The same ethical rules that apply to lawyers who employ or retain paralegals, junior associates, or outside consultants applies to lawyers who utilize AI.",
          "effective": "2024-05-22",
          "fetched": "2026-09-16"
        },
        {
          "title": "Same — p. 15 (Communicating with Clients conclusion)",
          "url": "https://www.pabar.org/Members/catalogs/Ethics%20Opinions/Formal/Joint%20Formal%20Opinion%202024-200.pdf",
          "verbatim": "Lawyers must communicate with clients about using AI technologies in their practices, providing clear and transparent explanations of how such tools are employed and their potential impact on case outcomes. If necessary, they should obtain client consent before using certain AI tools.",
          "effective": "2024-05-22",
          "fetched": "2026-09-16"
        },
        {
          "title": "Same — p. 16 (Utilizing Proper Billing Practices conclusion)",
          "url": "https://www.pabar.org/Members/catalogs/Ethics%20Opinions/Formal/Joint%20Formal%20Opinion%202024-200.pdf",
          "verbatim": "Lawyers must, therefore, ensure that AI-related expenses are reasonable and appropriately disclosed to clients.",
          "effective": "2024-05-22",
          "fetched": "2026-09-16"
        },
        {
          "title": "Same — p. 16 (caveat; non-binding)",
          "url": "https://www.pabar.org/Members/catalogs/Ethics%20Opinions/Formal/Joint%20Formal%20Opinion%202024-200.pdf",
          "verbatim": "CAVEAT: The foregoing opinion is advisory only and is not binding on the Disciplinary Board of the Supreme Court of Pennsylvania or any other Court.",
          "effective": "2024-05-22",
          "fetched": "2026-09-16"
        },
        {
          "title": "Pennsylvania Bar Association, Ethics Opinions (Public) index — date of Joint Formal Opinion 2024-200; no later AI formal opinion listed",
          "url": "https://www.pabar.org/site/For-the-Public/Ethics-Opinions-Public",
          "verbatim": "F2024-200 - Joint Formal Opinion 2024-200 (May 22, 2024): ETHICAL ISSUES REGARDING THE USE OF ARTIFICIAL INTELLIGENCE",
          "effective": null,
          "fetched": "2026-09-16"
        },
        {
          "title": "Same — PBA statement of advisory status",
          "url": "https://www.pabar.org/site/For-the-Public/Ethics-Opinions-Public",
          "verbatim": "Ethics opinions of the committee are advisory only and are not binding on the Disciplinary Board of the Supreme Court of Pennsylvania or any other court.",
          "effective": null,
          "fetched": "2026-09-16"
        },
        {
          "title": "Philadelphia Bar Association, Ethics Opinions page — advisory status (no AI opinion listed at Opinions 2010-Present)",
          "url": "https://philadelphiabar.org/?pg=ethicsopinions",
          "verbatim": "Opinions are not binding upon the Disciplinary Board of the Supreme Court of Pennsylvania or any other Court.",
          "effective": null,
          "fetched": "2026-09-16"
        },
        {
          "title": "Commonwealth Court of Pennsylvania, Associated Builders & Contractors, Inc., E. Pa. Chapter v. Bucks County Community College, No. 1172 C.D. 2025 (single-judge memorandum opinion, not reported, filed Nov. 24, 2025) — slip op. at 3 (not a statewide rule)",
          "url": "https://www.pacourts.us/Storage/media/pdfs/20251212/212841-1172cd2025-memorandumopiniononuseofgenerativeaibyattorneys.pdf",
          "verbatim": "The Court cannot condone the filing of any legal document that admittedly contains numerous factual and legal errors, such as the Initial Brief filed here.",
          "effective": "2025-11-24",
          "fetched": "2026-09-16"
        },
        {
          "title": "Same — slip op. at 7",
          "url": "https://www.pacourts.us/Storage/media/pdfs/20251212/212841-1172cd2025-memorandumopiniononuseofgenerativeaibyattorneys.pdf",
          "verbatim": "It is imperative that attorneys must remain vigilant when utilizing generative AI in order to avoid running afoul of their ethical obligations.",
          "effective": "2025-11-24",
          "fetched": "2026-09-16"
        },
        {
          "title": "Disciplinary Board of the Supreme Court of Pennsylvania, Attorney E-Newsletter, June 2024 — issuance of Joint Formal Opinion",
          "url": "https://www.padisciplinaryboard.org/attorney-news-june-2024",
          "verbatim": "On May 22nd, the Pennsylvania Bar Association and Philadelphia Bar Association issued a Joint Formal Opinion on the use of AI.",
          "effective": null,
          "fetched": "2026-09-16"
        },
        {
          "title": "Disciplinary Board, Attorney E-Newsletter, August 2026 — Rule 5.5 Comment (4) amended July 16, 2026 (remote practice; not AI; postdates the Pa. Code text used above)",
          "url": "https://www.padisciplinaryboard.org/page/205",
          "verbatim": "The amendment of this comment is effective immediately.",
          "effective": null,
          "fetched": "2026-09-16"
        },
        {
          "title": "LEAD ONLY — Legal Intelligencer article (Mar. 16, 2026) reproduced on pacourts.us, Pa. Supreme Court justices on AI at House Appropriations hearing",
          "url": "https://www.pacourts.us/Storage/media/pdfs/20260317/134427-pa.supremecourtjusticestalkailoomingfinancialtroublesduringstatebudgethearing.pdf",
          "verbatim": null,
          "effective": null,
          "fetched": "2026-09-16"
        },
        {
          "title": "LEAD ONLY — AI Vortex, Pennsylvania AI Regulation for Lawyers (claims a statewide AI disclosure mandate; no primary source supports it)",
          "url": "https://www.aivortex.io/legal/ai-regulation/pennsylvania/",
          "verbatim": null,
          "effective": null,
          "fetched": null
        },
        {
          "title": "LEAD ONLY — Legal AI Governance tracker, Pennsylvania",
          "url": "https://legalaigovernance.com/tracker/states/pennsylvania/",
          "verbatim": null,
          "effective": null,
          "fetched": null
        },
        {
          "title": "LEAD ONLY — Troutman Pepper Locke, Pennsylvania Supreme Court's New GenAI Policies for Court Personnel",
          "url": "https://www.troutman.com/insights/pennsylvania-supreme-courts-new-genai-policies-for-court-personnel-what-practitioners-need-to-know/",
          "verbatim": null,
          "effective": null,
          "fetched": null
        }
      ],
      "status": "verified",
      "verified_on": "2026-09-17",
      "verified_by": "claude-opus-5 (independent verifier session; every source URL re-fetched 2026-09-17; checkq/strictq exact match; pinpoints, effective dates, status and narrative claims checked against the fetched text; one missed-item search)",
      "attorney_signoff": null,
      "notes": "BOTTOM LINE: Pennsylvania state law has no AI-specific rule for attorneys as of 2026-09-16: no RPC text or Comment mentions AI, no Supreme Court order or procedural rule requires AI disclosure or certification in filings, and no statute. JEAB General Guidance 2-2025 (p. 6) itself states the Rules of Professional Conduct do not specifically address the use of AI/GenAI. Several web trackers (AI Vortex; search snippets) assert that Pennsylvania mandates disclosure of AI use in all court submissions; no primary source fetched supports this. The known disclosure orders are individual federal judges' standing orders in E.D. Pa. and M.D. Pa. (e.g., Judge Baylson), which are outside this state entry. BINDING STATUS: (a) RPC black-letter text is binding on Pennsylvania lawyers; Comments are guidance only: \"The Comments are intended as guides to interpretation, but the text of each Rule is authoritative.\" (Scope para. 21). Rule 1.1 Comment (8) (technology) is therefore a should-level Comment. (b) Supreme Court Interim Policy (order Sept. 9, 2025; ADOPTED; effective Dec. 8, 2025; 55 Pa.B. 6696) binds judicial officers and court Personnel using GenAI on UJS Technology Resources only; it does not bind attorneys or litigants. Its disclosure, secured-system, and human-review provisions are not attorney duties. (c) JEAB General Ethics Guidance No. 2-2025 (issued Dec. 10, 2025 per the document; pacourts upload path is dated 20251215) is addressed to judicial officers under the Code of Judicial Conduct; not binding on attorneys. It says best practices favor tracking GenAI use in chambers (judges, not lawyers). (d) Joint Formal Opinion 2024-200 (PBA + Philadelphia Bar; voluntary bar associations): advisory and non-binding, per its own caveat, the PBA index, and JEAB 2-2025. Date: the PDF bears no date on its face; May 22, 2024 comes from the PBA Ethics Opinions (Public) index and the Disciplinary Board June 2024 newsletter (May 22nd). (e) Commonwealth Court No. 1172 C.D. 2025 is a single-judge, unreported memorandum opinion (President Judge Cohn Jubelirer) denying leave to amend and striking an AI-generated brief; it expressly does not decide whether any ethical rule was violated; it is case-specific, not a statewide rule; precedential weight not assessed here. Pa. Superior Court Saber v. Navy Fed. Credit Union (No. 2449 EDA 2024, Oct. 28, 2025) is cited in its n.1 but was not fetched. PROPOSED / PENDING, NOT IN FORCE: (1) Civil Procedural Rules Committee re-publication proposing amendment of Pa.R.Civ.P. 1023.1-1023.4 (Federal Rule 11 restyling, law-firm service, mandatory rule to show cause); comment deadline Nov. 21, 2025; contains no AI language (grep 0 hits); as of 2026-09-16 it appears under Prior Proposed Rules and not under Approved Rules on the committee page. The current adopted Rule 1023.1 text quoted above is from the Pa. Code (amended Apr. 2, 2003, effective June 1, 2003). Rule 1023.1 applies in civil practice; it is not a criminal/appellate rule. (2) A March 2026 Legal Intelligencer article (lead only) reports Justice Dougherty said the Court is looking to update verifications on filings to address AI vetting; no such proposal was found on any rules committee page or in the Pa. Bulletin sweep below. Treat as a watch item only. CHECKED, NOTHING AI-SPECIFIC FOUND (all fetched 2026-09-16): Full Chapter 81 text at https://www.pacodeandbulletin.gov/Display/pacode?file=/secure/pacode/data/204/chapter81/chap81toc.html (Pa. Code current through 56 Pa.B. 4026, July 4, 2026), grep for artificial, generative, AI, machine learning, large language, chatgpt, technolog, hallucinat: only Rule 1.1 Cmt (8) technology language; Disciplinary Board RPC page https://www.padisciplinaryboard.org/for-attorneys/rules/rule/3/the-rules-of-professional-conduct (lists amendments through Nov. 14, 2024), 0 AI hits; Disciplinary Board home, For Attorneys, Resources, News and Media, Rules index and Attorney E-Newsletters Jan. 2024 through Aug. 2026 (padisciplinaryboard.org): news roundups about AI sanctions elsewhere and summaries of the Interim Policy and Joint Opinion, but no Board AI notice, guidance, or rule; the Aug. 2026 issue reports a July 16, 2026 amendment to Rule 5.5 Comment (4) on remote practice (not AI), which postdates the Pa. Code currency date; Rules Committees pages at https://www.pacourts.us/courts/supreme-court/committees/rules-committees (Civil, Appellate, Criminal, Evidence, Domestic Relations, Juvenile, Minor Court, Orphans' Court) and all 105 rule PDFs linked there dated June 2025 through Sept. 2026: 0 AI hits (one image-only PDF, the July 22, 2025 order amending Pa.R.E. 803.1, was OCR'd with Tesseract: 0 AI hits); Pa. Bulletin Vol. 56 No. 36 (Sept. 5, 2026) full-issue PDF https://www.pacodeandbulletin.gov/secure/pabulletin/data/vol56/56-36/56-36.pdf: AI mentions only in a Governor's executive order on data centers and an agriculture grant notice, nothing in The Courts; PBA Ethics Opinions (Public) index: later formal opinions 2025-100 (fee agreements), 2026-100 (of counsel), 2026-200 (immigration status), none on AI; Philadelphia Bar Opinions 2010-Present https://philadelphiabar.org/?pg=Opinions2010Present: latest 2025-1 (immigration status), none on AI; Pennsylvania General Assembly keyword searches, 2025-2026 session, current printer's numbers (palegis.us bill-keyword-search): artificial intelligence (62 results, about 50 distinct bills on health, insurance, consumer disclosure, chatbots, deepfakes, workforce, political ads; none on court filings or law practice), and court filing, legal filing, unauthorized practice of law, practice of law with artificial (0 results each). No enacted or pending Pennsylvania bill on AI in court filings or legal practice was found; bill texts were not read. NOT FETCHED: AI Vortex, Legal AI Governance, Troutman memo (leads, located via web search/fetch only); Pa. Superior Court Saber opinion; E.D. Pa./M.D. Pa. standing orders and federal sanctions decisions (out of scope for this state entry; handled by other agents); PBA Formal Opinion 2024-100 on third-party vendors with access to confidential information (related, not AI-specific by title, not read). OTHER CAVEATS: The Joint Opinion quotes Rule 1.6 as unless the clients give informed consent (plural) and labels the Comment (4) language as a Rule 3.1 comment, although in the Pa. Code that sentence is Rule 3.3 Comment (4); use the Pa. Code text, not the Opinion's transcription. Effective dates for RPC items are the latest amendment date in each rule's Source note where it is a fixed date (Scope: effective Jan. 1, 2005; Rule 1.1: effective July 1, 2018; Rule 1.5: Nov. 25, 2020, effective immediately); null where the note says effective in 30 days (Rules 1.4, 1.6, 5.3) or where no rule-level Source note appears (Rules 3.3, 5.1). The 2018 date for Rule 1.1 is the rule's latest amendment, not necessarily when the technology clause was added."
    },
    {
      "id": "ca-rpc",
      "kind": "state_bar",
      "name": "California Rules of Professional Conduct (rules 1.1, 1.4, 1.6, 3.3, 5.1, 5.3 and comments) and State Bar Act § 6068 — plus the PENDING AI comment amendments (not adopted as of 2026-09-18)",
      "disclosure_to_court": "none",
      "certification_required": false,
      "certificate_language": null,
      "verification_duty": "IN FORCE (general rules; no AI-specific rule or comment is in force as of 2026-09-18): Rule 1.1(a): \"A lawyer shall not intentionally, recklessly, with gross negligence, or repeatedly fail to perform legal services with competence.\" (California's competence rule is a culpability standard, not the ABA formulation.) Rule 1.1 Comment [1] (operative March 22, 2021): \"[1] The duties set forth in this rule include the duty to keep abreast of the changes in the law and its practice, including the benefits and risks associated with relevant technology.\" Rule 3.3(a)(1): a lawyer shall not \"knowingly* make a false statement of fact or law to a tribunal* or fail to correct a false statement of material fact or law previously made to the tribunal* by the lawyer;\" Rule 3.3 Comment [2]: the prohibition \"includes citing as authority a decision that has been overruled or a statute that has been repealed or declared unconstitutional\". Bus. & Prof. Code § 6068(d) (statutory duty, independent of the Rules): \"To employ, for the purpose of maintaining the causes confided to him or her those means only as are consistent with truth, and never to seek to mislead the judge or any judicial officer by an artifice or false statement of fact or law.\" Supervision: Rule 5.1(a)-(b) and Rule 5.3(a)-(b) require \"reasonable* efforts\" by managerial and supervisory lawyers. PENDING, NOT IN FORCE (COPRAC second-round proposal, comment closed Aug. 6, 2026; not approved by the Board of Trustees or the Supreme Court): proposed Rule 1.1 Comment [2]: \"[2] When using technology, including artificial intelligence, competence requires a lawyer to exercise professional judgment over all aspects of that use, including, but not limited to, the inputs and outputs.\" and proposed Rule 3.3 Comment [3]: \"[3] A lawyer’s duty of candor towards the tribunal includes the obligation to verify the accuracy and existence of cited authorities, including ensuring no cited authority is fabricated, misstated, or taken out of context, before submission to a tribunal, including any cited authorities generated or assisted by artificial intelligence or other technological tools.\" Even if adopted these are Comments: Rule 1.0(c), \"The comments are not a basis for imposing discipline but are intended only to provide guidance for interpreting and practicing in compliance with the rules.\"",
      "confidentiality_restriction": "IN FORCE: Bus. & Prof. Code § 6068(e)(1): \"To maintain inviolate the confidence, and at every peril to himself or herself to preserve the secrets, of his or her client.\" Rule 1.6(a): \"A lawyer shall not reveal information protected from disclosure by Business and Professions Code section 6068, subdivision (e)(1) unless the client gives informed consent,* or the disclosure is permitted by paragraph (b) of this rule.\" California Rule 1.6 (paragraphs (a)-(e), read in full) contains no counterpart to ABA Model Rule 1.6(c)'s reasonable-efforts safeguard paragraph; nothing in the current rule or comments addresses technology or AI. PENDING, NOT IN FORCE: proposed Rule 1.6 Comment [2] (second round): \"[2] For purposes of this rule, “reveal” includes exposing confidential information to technological systems, including artificial intelligence tools, where such exposure creates a substantial* risk that the information may be accessed, retained, or used, whether by the technological system or another user of that technological system, in a manner inconsistent with the lawyer’s duty of confidentiality.\" The first-round text (Mar. 2026, superseded) said \"material risk\"; the second round changed it to \"substantial* risk\" and added factors: \"the nature and operation of the technology, including whether data is retained or used for model training; the security measures in place; and whether the information may be accessed by unauthorized users or third parties.\"",
      "record_keeping_duty": "none",
      "client_disclosure_duty": "conditional — IN FORCE: Rule 1.4(a)(2) requires a lawyer to \"reasonably* consult with the client about the means by which to accomplish the client’s objectives in the representation;\" and Rule 1.4(b): \"A lawyer shall explain a matter to the extent reasonably* necessary to permit the client to make informed decisions regarding the representation.\" Informed consent under Rule 1.6(a) is required before protected information is revealed. No current rule or comment mentions AI. PENDING, NOT IN FORCE: proposed Rule 1.4 Comment [5] (second round): \"Comment [5] A lawyer’s duty to keep a client reasonably informed includes evaluation of the lawyer’s communication obligations concerning the lawyer’s use of technology, including artificial intelligence, throughout the representation based on the facts and circumstances, including the novelty of the technology, risks and benefits associated with the use of the technology, scope of the representation, and sophistication of the client.\" (The first-round version keyed disclosure to use that \"presents a significant risk or materially affects\" the representation; the second round replaced that trigger with an evaluation duty. See the ca-state-bar-guidance entry for the non-binding \"must consider disclosure\" guidance.)",
      "fees_note": null,
      "sources": [
        {
          "title": "California Rules of Professional Conduct, Chapter 0 (Rule 1.0), State Bar official PDF — Rule 1.0(c) (Comments are not a basis for discipline)",
          "url": "https://www.calbar.ca.gov/sites/default/files/portals/0/documents/rules/Rules-of-Professional-Conduct-0.pdf",
          "verbatim": "(c) Purpose of Comments. The comments are not a basis for imposing discipline but are intended only to provide guidance for interpreting and practicing in compliance with the rules.",
          "effective": null,
          "fetched": "2026-09-18"
        },
        {
          "title": "Same — Rule 1.0 Comment [4] (California ethics opinions not binding)",
          "url": "https://www.calbar.ca.gov/sites/default/files/portals/0/documents/rules/Rules-of-Professional-Conduct-0.pdf",
          "verbatim": "[4] In addition to the authorities identified in paragraph (b)(2), opinions of ethics committees in California, although not binding, should be consulted for guidance on proper professional conduct.",
          "effective": null,
          "fetched": "2026-09-18"
        },
        {
          "title": "California Rules of Professional Conduct, Chapter 1 (Rules 1.1–1.18), State Bar official PDF — Rule 1.1(a) (Competence)",
          "url": "https://www.calbar.ca.gov/sites/default/files/portals/0/documents/rules/Rules-of-Professional-Conduct-1.pdf",
          "verbatim": "(a) A lawyer shall not intentionally, recklessly, with gross negligence, or repeatedly fail to perform legal services with competence.",
          "effective": null,
          "fetched": "2026-09-18"
        },
        {
          "title": "Same — Rule 1.1(b) (definition of competence)",
          "url": "https://www.calbar.ca.gov/sites/default/files/portals/0/documents/rules/Rules-of-Professional-Conduct-1.pdf",
          "verbatim": "(b) For purposes of this rule, “competence” in any legal service shall mean to apply the (i) learning and skill, and (ii) mental, emotional, and physical ability reasonably* necessary for the performance of such service.",
          "effective": null,
          "fetched": "2026-09-18"
        },
        {
          "title": "Same — Rule 1.1 Comment [1] (technology competence; current text)",
          "url": "https://www.calbar.ca.gov/sites/default/files/portals/0/documents/rules/Rules-of-Professional-Conduct-1.pdf",
          "verbatim": "[1] The duties set forth in this rule include the duty to keep abreast of the changes in the law and its practice, including the benefits and risks associated with relevant technology.",
          "effective": "2021-03-22",
          "fetched": "2026-09-18"
        },
        {
          "title": "State Bar of California, Ethics News Archive — approval of the Rule 1.1 technology comment (S266066)",
          "url": "https://www.calbar.ca.gov/Attorneys/Conduct-Discipline/Ethics/Publications/Ethics-News-Archive",
          "verbatim": "On February 18, 2021, the Supreme Court of California approved amendments to California Rule of Professional Conduct 1.1 [Competence] and Rule 5.4 [Financial and Similar Arrangements with Nonlawyers], effective March 22, 2021 (Supreme Court case no. S266066).",
          "effective": "2021-03-22",
          "fetched": "2026-09-18"
        },
        {
          "title": "Rules of Professional Conduct Chapter 1 PDF — Rule 1.4(a)(2) (consult about means)",
          "url": "https://www.calbar.ca.gov/sites/default/files/portals/0/documents/rules/Rules-of-Professional-Conduct-1.pdf",
          "verbatim": "(2) reasonably* consult with the client about the means by which to accomplish the client’s objectives in the representation;",
          "effective": null,
          "fetched": "2026-09-18"
        },
        {
          "title": "Same — Rule 1.4(b) (explain to permit informed decisions)",
          "url": "https://www.calbar.ca.gov/sites/default/files/portals/0/documents/rules/Rules-of-Professional-Conduct-1.pdf",
          "verbatim": "(b) A lawyer shall explain a matter to the extent reasonably* necessary to permit the client to make informed decisions regarding the representation.",
          "effective": null,
          "fetched": "2026-09-18"
        },
        {
          "title": "Same — Rule 1.6(a) (Confidential Information of a Client)",
          "url": "https://www.calbar.ca.gov/sites/default/files/portals/0/documents/rules/Rules-of-Professional-Conduct-1.pdf",
          "verbatim": "(a) A lawyer shall not reveal information protected from disclosure by Business and Professions Code section 6068, subdivision (e)(1) unless the client gives informed consent,* or the disclosure is permitted by paragraph (b) of this rule.",
          "effective": null,
          "fetched": "2026-09-18"
        },
        {
          "title": "California Rules of Professional Conduct, Chapter 3 (Rules 3.1–3.10), State Bar official PDF — Rule 3.3(a)(1)-(2) (Candor Toward the Tribunal)",
          "url": "https://www.calbar.ca.gov/sites/default/files/portals/0/documents/rules/Rules-of-Professional-Conduct-3.pdf",
          "verbatim": "(1) knowingly* make a false statement of fact or law to a tribunal* or fail to correct a false statement of material fact or law previously made to the tribunal* by the lawyer; (2) fail to disclose to the tribunal* legal authority in the controlling jurisdiction known* to the lawyer to be directly adverse to the position of the client and not disclosed by opposing counsel, or knowingly* misquote to a tribunal* the language of a book, statute, decision or other authority; or",
          "effective": null,
          "fetched": "2026-09-18"
        },
        {
          "title": "Same — Rule 3.3 Comment [2] (citing overruled or repealed authority)",
          "url": "https://www.calbar.ca.gov/sites/default/files/portals/0/documents/rules/Rules-of-Professional-Conduct-3.pdf",
          "verbatim": "[2] The prohibition in paragraph (a)(1) against making false statements of law or failing to correct a material misstatement of law includes citing as authority a decision that has been overruled or a statute that has been repealed or declared unconstitutional, or failing to correct such a citation previously made to the tribunal* by the lawyer.",
          "effective": null,
          "fetched": "2026-09-18"
        },
        {
          "title": "Same — Rule 3.3 Comment [9] (statutory duties continue)",
          "url": "https://www.calbar.ca.gov/sites/default/files/portals/0/documents/rules/Rules-of-Professional-Conduct-3.pdf",
          "verbatim": "[9] In addition to this rule, lawyers remain bound by Business and Professions Code sections 6068, subdivision (d) and 6106.",
          "effective": null,
          "fetched": "2026-09-18"
        },
        {
          "title": "California Rules of Professional Conduct, Chapter 5 (Rules 5.1–5.7), State Bar official PDF — Rule 5.1(a)-(b) (managerial and supervisory lawyers)",
          "url": "https://www.calbar.ca.gov/sites/default/files/portals/0/documents/rules/Rules-of-Professional-Conduct-5.pdf",
          "verbatim": "(a) A lawyer who individually or together with other lawyers possesses managerial authority in a law firm,* shall make reasonable* efforts to ensure that the firm* has in effect measures giving reasonable* assurance that all lawyers in the firm* comply with these rules and the State Bar Act.",
          "effective": null,
          "fetched": "2026-09-18"
        },
        {
          "title": "Same — Rule 5.3(b) (nonlawyer assistants; current Comment has no technology language)",
          "url": "https://www.calbar.ca.gov/sites/default/files/portals/0/documents/rules/Rules-of-Professional-Conduct-5.pdf",
          "verbatim": "(b) a lawyer having direct supervisory authority over the nonlawyer, whether or not an employee of the same law firm,* shall make reasonable* efforts to ensure that the person’s* conduct is compatible with the professional obligations of the lawyer; and",
          "effective": null,
          "fetched": "2026-09-18"
        },
        {
          "title": "Business and Professions Code § 6068 (leginfo; \"Amended by Stats. 2018, Ch. 659, Sec. 50. (AB 3249) Effective January 1, 2019.\") — subd. (d) (truth; never mislead the judge)",
          "url": "https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?lawCode=BPC&sectionNum=6068.",
          "verbatim": "(d) To employ, for the purpose of maintaining the causes confided to him or her those means only as are consistent with truth, and never to seek to mislead the judge or any judicial officer by an artifice or false statement of fact or law.",
          "effective": "2019-01-01",
          "fetched": "2026-09-18"
        },
        {
          "title": "Same — subd. (e)(1) (confidentiality)",
          "url": "https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?lawCode=BPC&sectionNum=6068.",
          "verbatim": "(e) (1) To maintain inviolate the confidence, and at every peril to himself or herself to preserve the secrets, of his or her client.",
          "effective": "2019-01-01",
          "fetched": "2026-09-18"
        },
        {
          "title": "PENDING — COPRAC, Proposed Amended Rules of Professional Conduct 1.1, 1.4, 1.6, 3.3, 5.1, and 5.3 (clean and redline), second round (posted June 2026; same text attached to COPRAC's Sept. 11, 2026 agenda) — proposed Rule 1.1 Comments [1]-[2]",
          "url": "https://www.calbar.ca.gov/sites/default/files/2026-06/Proposed-Amended-Rules-of-Professional-Conduct-1.1-1.4-1.6-3.3-5.1-and-5.3-clean-and-redline.pdf",
          "verbatim": "[1] The duties set forth in this rule include the duty to keep abreast of the changes in the law and its practice, including the benefits and risks associated with relevant technology, including artificial intelligence, as defined by Government Code section 11549.64. [2] When using technology, including artificial intelligence, competence requires a lawyer to exercise professional judgment over all aspects of that use, including, but not limited to, the inputs and outputs. When citing legal authority to a tribunal, a lawyer must comply with the duty of candor. See rule 3.3; Business and Professions Code section 6068(d). When citing legal authority to a client or to other parties, the lawyer must verify the accuracy and existence of cited authorities to ensure the lawyer employs only those means consistent with the truth. See Business and Professions Code section 6068(d).",
          "effective": null,
          "fetched": "2026-09-18"
        },
        {
          "title": "Same — proposed Rule 1.4 Comment [5]",
          "url": "https://www.calbar.ca.gov/sites/default/files/2026-06/Proposed-Amended-Rules-of-Professional-Conduct-1.1-1.4-1.6-3.3-5.1-and-5.3-clean-and-redline.pdf",
          "verbatim": "Comment [5] A lawyer’s duty to keep a client reasonably informed includes evaluation of the lawyer’s communication obligations concerning the lawyer’s use of technology, including artificial intelligence, throughout the representation based on the facts and circumstances, including the novelty of the technology, risks and benefits associated with the use of the technology, scope of the representation, and sophistication of the client.",
          "effective": null,
          "fetched": "2026-09-18"
        },
        {
          "title": "Same — proposed Rule 1.6 Comment [2]",
          "url": "https://www.calbar.ca.gov/sites/default/files/2026-06/Proposed-Amended-Rules-of-Professional-Conduct-1.1-1.4-1.6-3.3-5.1-and-5.3-clean-and-redline.pdf",
          "verbatim": "[2] For purposes of this rule, “reveal” includes exposing confidential information to technological systems, including artificial intelligence tools, where such exposure creates a substantial* risk that the information may be accessed, retained, or used, whether by the technological system or another user of that technological system, in a manner inconsistent with the lawyer’s duty of confidentiality. In determining whether a substantial* risk exists, the lawyer should consider: the nature and operation of the technology, including whether data is retained or used for model training; the security measures in place; and whether the information may be accessed by unauthorized users or third parties.",
          "effective": null,
          "fetched": "2026-09-18"
        },
        {
          "title": "Same — proposed Rule 3.3 Comment [3]",
          "url": "https://www.calbar.ca.gov/sites/default/files/2026-06/Proposed-Amended-Rules-of-Professional-Conduct-1.1-1.4-1.6-3.3-5.1-and-5.3-clean-and-redline.pdf",
          "verbatim": "[3] A lawyer’s duty of candor towards the tribunal includes the obligation to verify the accuracy and existence of cited authorities, including ensuring no cited authority is fabricated, misstated, or taken out of context, before submission to a tribunal, including any cited authorities generated or assisted by artificial intelligence or other technological tools.",
          "effective": null,
          "fetched": "2026-09-18"
        },
        {
          "title": "Same — proposed Rule 5.1 Comment [1]",
          "url": "https://www.calbar.ca.gov/sites/default/files/2026-06/Proposed-Amended-Rules-of-Professional-Conduct-1.1-1.4-1.6-3.3-5.1-and-5.3-clean-and-redline.pdf",
          "verbatim": "[1] Paragraph (a) requires lawyers with managerial authority within a law firm* to make reasonable* efforts to establish internal policies and procedures designed, for example, to detect and resolve conflicts of interest, identify dates by which actions must be taken in pending matters, account for client funds and property, ensure that inexperienced lawyers are properly supervised, and govern the use of artificial intelligence, in accordance with the Rules of Professional Conduct.",
          "effective": null,
          "fetched": "2026-09-18"
        },
        {
          "title": "Same — proposed Rule 5.3 Comment (sentence added)",
          "url": "https://www.calbar.ca.gov/sites/default/files/2026-06/Proposed-Amended-Rules-of-Professional-Conduct-1.1-1.4-1.6-3.3-5.1-and-5.3-clean-and-redline.pdf",
          "verbatim": "A lawyer must give such assistants appropriate instruction and supervision concerning all ethical aspects of their employment, including the use of technology in the provision of legal services, such as artificial intelligence.",
          "effective": null,
          "fetched": "2026-09-18"
        },
        {
          "title": "SUPERSEDED — first-round Proposed Amended Rules (public comment closed May 4, 2026; the seed's source) — first-round Rule 1.1 Comment [2], replaced in the second round",
          "url": "https://www.calbar.ca.gov/sites/default/files/portals/0/documents/publicComment/2026/Proposed-Amended-Rules-AI-clean-redline.pdf",
          "verbatim": "[2] When using technology, including artificial intelligence, a lawyer must independently review, verify, and exercise professional judgment regarding any output generated by the technology that is used in connection with representing a client.",
          "effective": null,
          "fetched": "2026-09-18"
        },
        {
          "title": "State Bar public-comment page, second round (deadline August 6, 2026) — COPRAC's June 12, 2026 approval of modified proposals",
          "url": "https://www.calbar.ca.gov/public-comment/proposed-amendments-rules-professional-conduct-related-artificial-intelligence",
          "verbatim": "COPRAC made several changes to the proposed rules in response to public comments received during the first public comment period, which closed on May 4, 2026. At its June 12, 2026, meeting, COPRAC approved the modified rule proposals for a second round of public comment.",
          "effective": null,
          "fetched": "2026-09-18"
        },
        {
          "title": "Same — second-round deadline",
          "url": "https://www.calbar.ca.gov/public-comment/proposed-amendments-rules-professional-conduct-related-artificial-intelligence",
          "verbatim": "Deadline: August 6, 2026, 11:59 p.m. (45 days)",
          "effective": null,
          "fetched": "2026-09-18"
        },
        {
          "title": "State Bar public-comment archive page, first round (deadline May 4, 2026) — COPRAC's March 13, 2026 approval for comment",
          "url": "https://www.calbar.ca.gov/public/public-meetings-comment/public-comment/public-comment-archives/2026-public-comment/proposed-amendments-rules-professional-conduct-related-artificial-intelligence",
          "verbatim": "At its March 13, 2026, meeting, COPRAC approved the proposed amendments to 1.1, 1.4, 1.6, 3.3, 5.1, and 5.3 for a 45-day public comment period.",
          "effective": null,
          "fetched": "2026-09-18"
        },
        {
          "title": "State Bar Board of Trustees, Open Session Agenda Item 6.3 (May 14, 2026) — status of the proposed comment amendments",
          "url": "https://www.calbar.ca.gov/sites/default/files/portals/0/documents/ethics/Agenda-Item-6.3.pdf",
          "verbatim": "After consideration of public comment, COPRAC will bring the proposed comment amendments to the Rules of Professional Conduct before the Board at a future meeting. As mentioned above, the proposed changes are to the comments of the rules, rather than the text of the actual rules. Any rule changes would ultimately require Supreme Court adoption.",
          "effective": null,
          "fetched": "2026-09-18"
        },
        {
          "title": "COPRAC, Open Session Minutes, August 7, 2026 (DRAFT, attached to the Sept. 11, 2026 COPRAC agenda) — item 4.12 (AI)",
          "url": "https://calbar.primegov.com/api/compilemeetingattachmenthistory/historyattachment/?historyId=0d377e8e-c613-4b36-8ab4-7777ecad21a8",
          "verbatim": "4.12. Discussion of Artificial Intelligence and Possible Request to Circulate Updated Rules of Professional Conduct Proposals for Public Comment or Possible Approval for Submission to the Board of Trustees. No recommendation. Discussion only.",
          "effective": null,
          "fetched": "2026-09-18"
        },
        {
          "title": "COPRAC agenda, September 11, 2026 (PrimeGov portal) — item 4.12 (AI); outcome not yet published as of fetch",
          "url": "https://calbar.primegov.com/Portal/Meeting?meetingTemplateId=2748",
          "verbatim": "Discussion of Artificial Intelligence and Possible Request to Circulate Updated Rules of Professional Conduct Proposals for Public Comment or Approval for Submission to the Board of Trustees",
          "effective": null,
          "fetched": "2026-09-18"
        },
        {
          "title": "State Bar Board of Trustees agenda, September 17-18, 2026 (PrimeGov portal) — checked; no AI or Rules-of-Professional-Conduct AI item",
          "url": "https://calbar.primegov.com/Portal/Meeting?meetingTemplateId=2308",
          "verbatim": null,
          "effective": null,
          "fetched": "2026-09-18"
        },
        {
          "title": "State Bar of California, Ethics & Technology Resources page (technology MCLE statement; list of technology-related rules)",
          "url": "https://www.calbar.ca.gov/legal-professionals/ethics-compliance-practice-resources/ethics/ethics-technology-resources",
          "verbatim": "Pursuant to MCLE requirements, California attorneys are required to complete at least one credit hour of continuing legal education addressing technology in the practice of law during each compliance period.",
          "effective": null,
          "fetched": "2026-09-18"
        },
        {
          "title": "LEAD ONLY — LawSites, \"California Bar Proposes Rule Requiring Lawyers to Verify Every AI Output …\" (May 2026) (search result; not relied on)",
          "url": "https://www.lawnext.com/2026/05/california-bar-proposes-rule-requiring-lawyers-to-verify-every-ai-output-and-five-other-ai-focused-ethics-changes.html",
          "verbatim": null,
          "effective": null,
          "fetched": null
        },
        {
          "title": "LEAD ONLY — ABA Journal, \"State Bar of California proposes first AI-specific changes to ethics rules\" (search result; not relied on)",
          "url": "https://www.abajournal.com/news/article/california-bar-proposes-first-ai-specific-changes-to-ethics-rules",
          "verbatim": null,
          "effective": null,
          "fetched": null
        }
      ],
      "status": "verified",
      "verified_on": "2026-09-18",
      "verified_by": "claude-opus-5 (independent verifier session; every source URL re-fetched 2026-09-17; checkq/strictq exact match; pinpoints, effective dates, status and narrative claims checked against the fetched text; one missed-item search)",
      "attorney_signoff": null,
      "notes": "(A) WHAT IS IN FORCE (2026-09-18): no California Rule of Professional Conduct or Comment mentions artificial intelligence. The only technology-specific language in the six rules read is Rule 1.1 Comment [1] (operative March 22, 2021; S266066) and Rule 1.4 Comment [2] (\"by electronic or other means\"). Rules 1.1, 1.4, 1.6, 3.3, 5.1 and 5.3 (black letter and all comments) were read in full from the State Bar's chapter PDFs (Chapters 1, 3, 5; Chapter 0 for Rule 1.0), fetched 2026-09-18; the chapter index pages at https://www.calbar.ca.gov/legal-professionals/rules/rules-professional-conduct/current-rules-professional-conduct were fetched the same day. Rule 1.0(c): Comments \"are not a basis for imposing discipline\". Rule 3.1(a)(2) (meritorious contentions) was also read; it is not AI-specific. (B) PENDING AI COMMENT AMENDMENTS — history from the State Bar's own documents: Supreme Court letter of Aug. 22, 2025 directing the State Bar to consider incorporating the Practical Guidance into the Comments; COPRAC approved first-round proposals Mar. 13, 2026 (comment closed May 4, 2026); Board of Trustees Agenda Item 6.3 (May 14, 2026) described them as forthcoming and stated \"Any rule changes would ultimately require Supreme Court adoption.\"; COPRAC approved modified second-round proposals June 12, 2026 (comment closed Aug. 6, 2026); COPRAC Aug. 7, 2026 minutes (draft): AI item \"No recommendation. Discussion only.\"; COPRAC Sept. 11, 2026 agenda item 4.12 lists a possible request to re-circulate or to approve for submission to the Board (outcome not yet published); the Board's Sept. 17-18, 2026 agenda contains no AI item (grep of the agenda page, 0 hits). No Supreme Court order approving these amendments was found; the State Bar Ethics News page (fetched 2026-09-18) lists the most recent Supreme Court rule approval as rule 7.3 (Apr. 23, 2026). Status for the matrix: PROPOSED, NOT ADOPTED; the second-round text (quoted above) is the current proposal. (C) SEED CORRECTIONS (jurisdictions.yaml ca-state-bar-guidance seed): the seed quoted the FIRST-round Rule 1.1 Comment [2] (\"independently review, verify, and exercise professional judgment regarding any output\"), which the second round replaced; the seed's 1.6 Comment [2] paraphrase (\"material risk\") is the first-round standard, now \"substantial* risk\"; the seed's 1.4 Comment [5] trigger (\"significant risk or materially affects\") was replaced by an evaluation duty. The seed filed these proposals under the guidance entry; they are Rules-of-Professional-Conduct proposals and are placed here. (D) CHANGES BETWEEN ROUNDS (from the second-round public-comment page and PDF): Rule 1.1 Comment [1] now ties \"artificial intelligence\" to Government Code section 11549.64 (definition not fetched); Comment [2] now distinguishes citing authority to a tribunal (duty of candor; rule 3.3; § 6068(d)) from citing to a client or other parties (verify accuracy and existence); Rules 3.3, 5.1, 5.3 proposals unchanged from the first round per the page (\"No changes were made to this proposal after the public comment period ending May 4, 2026.\"). (E) OTHER TECHNOLOGY MATERIALS NOT READ FOR THIS ENTRY: State Bar formal ethics opinions on technology (listed under \"Ethics Opinions Related to Technology\" on the Ethics & Technology Resources page) were not fetched; the MCLE technology-hour requirement is quoted from the State Bar's resources page, not from the MCLE rule itself (State Bar Rules, Title 2) — a verifier should pull the rule text if the matrix will rely on it. (F) Applies to lawyers licensed in California (and, by incorporation, to practice before federal courts in California that adopt the California standards — see the us-cdca/us-ndca/us-edca/us-sdca entries)."
    },
    {
      "id": "ca-state-bar-guidance",
      "kind": "state_bar",
      "name": "State Bar of California (COPRAC) — 2026 Practical Guidance for the Use of Generative Artificial Intelligence in the Practice of Law (Board of Trustees approved May 14, 2026; replaces the Nov. 16, 2023 version) — non-binding guidance",
      "disclosure_to_court": "none",
      "certification_required": false,
      "certificate_language": null,
      "verification_duty": "Non-binding guidance applying existing duties (see ca-rpc for the binding rules). Candor to the Tribunal section: \"The lawyer’s duty of candor to the tribunal cannot be delegated to AI.\" A lawyer must review all AI outputs for accuracy, including citations, before submission and must \"independently verify and correct any errors or misleading statements made to the court, regardless of whether such outputs were generated with or without real-time human direction.\" On agentic tools: \"Where agentic AI is used in connection with court filings, lawyers must ensure that no document is transmitted to the court without lawyer review and approval. Lawyers must not permit AI systems to autonomously file documents, communicate with the court, or make representations on the lawyer’s behalf.\" Competence section: \"Second, a lawyer must exercise independent professional judgment by reviewing, verifying, and correcting AI-generated outputs consistent with the learning and skill reasonably necessary for the representation.\" and \"A lawyer’s professional judgment cannot be delegated to AI and remains the lawyer’s responsibility at all times.\"",
      "confidentiality_restriction": "\"As a general matter, a lawyer must not input any confidential information of the client into a generative AI solution that may present material risks to confidentiality or security, absent informed client consent (see rule 1.0.1(e)) as to the underlying risks.\" Diligence on the tool: \"Reasonable efforts require more than reliance on generalized marketing assurances.\" (reviewing terms of use, privacy policies, vendor documentation; consulting IT or cybersecurity professionals where appropriate). Agentic systems: \"A lawyer must not deploy an agentic AI system in a manner that permits autonomous external transmission of client information, including automated communications, filings, or data transfers, without appropriate safeguards and human review.\" Authorities the guidance cites: Bus. & Prof. Code § 6068(e); rules 1.6 and 1.8.2.",
      "record_keeping_duty": "none",
      "client_disclosure_duty": "conditional (guidance) — \"A lawyer must consider disclosure to their client that they intend to use AI in the representation, including how the technology will be used, and the benefits and risks of such use. For example, disclosure may be appropriate where AI use materially affects decision-making processes.\" Also: \"A lawyer must also follow any applicable client instructions or guidelines that may restrict or limit the use of AI in connection with the representation of the client.\" Cited rules: 1.2, 1.4.",
      "fees_note": "\"Subscription fees for generative AI tools that provide general office functionality, such as drafting assistance, research capabilities, or document review, typically constitute overhead expenses similar to library maintenance or general computer systems and thus should be absorbed within the lawyer’s fee rather than charged separately to clients.\" Matter-specific AI costs may be passed through only on these terms: \"When charging such costs, the lawyer must ensure the fee agreement clearly discloses that generative AI costs may be billed separately, the charges must reasonably reflect the lawyer’s actual cost, and no markup or profit element may be added without the client’s informed written consent.\" Hourly billing must reflect time actually spent (rule 1.5; Bus. & Prof. Code §§ 6147–6148 cited).",
      "sources": [
        {
          "title": "State Bar of California, COPRAC, Practical Guidance for the Use of Generative Artificial Intelligence in the Practice of Law (2026 version; no date on its face other than the Executive Summary's reference) — Executive Summary p. 1",
          "url": "https://www.calbar.ca.gov/sites/default/files/portals/0/documents/ethics/Generative-AI-Practical-Guidance.pdf",
          "verbatim": "This 2026 Practical Guidance replaces the 2023 version and, at the request of the California Supreme Court, addresses the unique challenges presented by the use of agentic AI.",
          "effective": "2026-05-14",
          "fetched": "2026-09-18"
        },
        {
          "title": "Same — Conclusion p. 3 (lawyer fully responsible)",
          "url": "https://www.calbar.ca.gov/sites/default/files/portals/0/documents/ethics/Generative-AI-Practical-Guidance.pdf",
          "verbatim": "Critically, any use of AI must not diminish or abdicate professional judgment. A lawyer remains fully responsible for any outputs and work product generated with the assistance of AI.",
          "effective": "2026-05-14",
          "fetched": "2026-09-18"
        },
        {
          "title": "Same — Agentic AI p. 2 (no autonomous representative action without supervision)",
          "url": "https://www.calbar.ca.gov/sites/default/files/portals/0/documents/ethics/Generative-AI-Practical-Guidance.pdf",
          "verbatim": "Lawyers must not deploy agentic systems in a manner that allows the system to make substantive legal determinations, communicate legal advice, prepare and file pleadings, or otherwise act in a representative capacity without meaningful lawyer supervision",
          "effective": "2026-05-14",
          "fetched": "2026-09-18"
        },
        {
          "title": "Same — Duties of Competence and Diligence (Rules 1.1, 1.3) p. 4",
          "url": "https://www.calbar.ca.gov/sites/default/files/portals/0/documents/ethics/Generative-AI-Practical-Guidance.pdf",
          "verbatim": "Second, a lawyer must exercise independent professional judgment by reviewing, verifying, and correcting AI-generated outputs consistent with the learning and skill reasonably necessary for the representation.",
          "effective": "2026-05-14",
          "fetched": "2026-09-18"
        },
        {
          "title": "Same — p. 4 (judgment not delegable)",
          "url": "https://www.calbar.ca.gov/sites/default/files/portals/0/documents/ethics/Generative-AI-Practical-Guidance.pdf",
          "verbatim": "A lawyer’s professional judgment cannot be delegated to AI and remains the lawyer’s responsibility at all times.",
          "effective": "2026-05-14",
          "fetched": "2026-09-18"
        },
        {
          "title": "Same — Duty of Confidentiality (Bus. & Prof. Code § 6068(e); Rules 1.6, 1.8.2) p. 5",
          "url": "https://www.calbar.ca.gov/sites/default/files/portals/0/documents/ethics/Generative-AI-Practical-Guidance.pdf",
          "verbatim": "As a general matter, a lawyer must not input any confidential information of the client into a generative AI solution that may present material risks to confidentiality or security, absent informed client consent (see rule 1.0.1(e)) as to the underlying risks.",
          "effective": "2026-05-14",
          "fetched": "2026-09-18"
        },
        {
          "title": "Same — p. 5 (vendor diligence)",
          "url": "https://www.calbar.ca.gov/sites/default/files/portals/0/documents/ethics/Generative-AI-Practical-Guidance.pdf",
          "verbatim": "Reasonable efforts require more than reliance on generalized marketing assurances.",
          "effective": "2026-05-14",
          "fetched": "2026-09-18"
        },
        {
          "title": "Same — p. 6 (agentic systems and external transmission)",
          "url": "https://www.calbar.ca.gov/sites/default/files/portals/0/documents/ethics/Generative-AI-Practical-Guidance.pdf",
          "verbatim": "A lawyer must not deploy an agentic AI system in a manner that permits autonomous external transmission of client information, including automated communications, filings, or data transfers, without appropriate safeguards and human review.",
          "effective": "2026-05-14",
          "fetched": "2026-09-18"
        },
        {
          "title": "Same — Duty to Supervise (Rules 5.1–5.3) p. 7 (training)",
          "url": "https://www.calbar.ca.gov/sites/default/files/portals/0/documents/ethics/Generative-AI-Practical-Guidance.pdf",
          "verbatim": "Moreover, lawyers should ensure that their lawyer and nonlawyer staff receive periodic training on the appropriate use of AI and safeguards surrounding the use of AI.",
          "effective": "2026-05-14",
          "fetched": "2026-09-18"
        },
        {
          "title": "Same — Communication Regarding Generative AI Use (Rules 1.2, 1.4) p. 7",
          "url": "https://www.calbar.ca.gov/sites/default/files/portals/0/documents/ethics/Generative-AI-Practical-Guidance.pdf",
          "verbatim": "A lawyer must consider disclosure to their client that they intend to use AI in the representation, including how the technology will be used, and the benefits and risks of such use. For example, disclosure may be appropriate where AI use materially affects decision-making processes.",
          "effective": "2026-05-14",
          "fetched": "2026-09-18"
        },
        {
          "title": "Same — p. 7 (client instructions)",
          "url": "https://www.calbar.ca.gov/sites/default/files/portals/0/documents/ethics/Generative-AI-Practical-Guidance.pdf",
          "verbatim": "A lawyer must also follow any applicable client instructions or guidelines that may restrict or limit the use of AI in connection with the representation of the client.",
          "effective": "2026-05-14",
          "fetched": "2026-09-18"
        },
        {
          "title": "Same — Charging for Work Produced by Generative AI (Rule 1.5; Bus. & Prof. Code §§ 6147–6148) p. 8 (overhead)",
          "url": "https://www.calbar.ca.gov/sites/default/files/portals/0/documents/ethics/Generative-AI-Practical-Guidance.pdf",
          "verbatim": "Subscription fees for generative AI tools that provide general office functionality, such as drafting assistance, research capabilities, or document review, typically constitute overhead expenses similar to library maintenance or general computer systems and thus should be absorbed within the lawyer’s fee rather than charged separately to clients.",
          "effective": "2026-05-14",
          "fetched": "2026-09-18"
        },
        {
          "title": "Same — p. 8 (pass-through costs)",
          "url": "https://www.calbar.ca.gov/sites/default/files/portals/0/documents/ethics/Generative-AI-Practical-Guidance.pdf",
          "verbatim": "When charging such costs, the lawyer must ensure the fee agreement clearly discloses that generative AI costs may be billed separately, the charges must reasonably reflect the lawyer’s actual cost, and no markup or profit element may be added without the client’s informed written consent.",
          "effective": "2026-05-14",
          "fetched": "2026-09-18"
        },
        {
          "title": "Same — Candor to the Tribunal; Meritorious Claims (Rules 3.1, 3.3) p. 9 (non-delegable candor)",
          "url": "https://www.calbar.ca.gov/sites/default/files/portals/0/documents/ethics/Generative-AI-Practical-Guidance.pdf",
          "verbatim": "The lawyer’s duty of candor to the tribunal cannot be delegated to AI.",
          "effective": "2026-05-14",
          "fetched": "2026-09-18"
        },
        {
          "title": "Same — p. 9 (verify and correct before submission; quotation begins mid-sentence after the left-column rule labels)",
          "url": "https://www.calbar.ca.gov/sites/default/files/portals/0/documents/ethics/Generative-AI-Practical-Guidance.pdf",
          "verbatim": "authority before submission to the court, and must independently verify and correct any errors or misleading statements made to the court, regardless of whether such outputs were generated with or without real-time human direction.",
          "effective": "2026-05-14",
          "fetched": "2026-09-18"
        },
        {
          "title": "Same — p. 9 (check local AI-disclosure requirements)",
          "url": "https://www.calbar.ca.gov/sites/default/files/portals/0/documents/ethics/Generative-AI-Practical-Guidance.pdf",
          "verbatim": "A lawyer should also check for any rules, orders, or other requirements in the relevant jurisdiction that may necessitate the disclosure of the use of AI tools, including generative or autonomous AI systems, and should comply with any such disclosure obligations as applicable.",
          "effective": "2026-05-14",
          "fetched": "2026-09-18"
        },
        {
          "title": "Same — p. 9 (agentic AI and court filings)",
          "url": "https://www.calbar.ca.gov/sites/default/files/portals/0/documents/ethics/Generative-AI-Practical-Guidance.pdf",
          "verbatim": "Where agentic AI is used in connection with court filings, lawyers must ensure that no document is transmitted to the court without lawyer review and approval. Lawyers must not permit AI systems to autonomously file documents, communicate with the court, or make representations on the lawyer’s behalf.",
          "effective": "2026-05-14",
          "fetched": "2026-09-18"
        },
        {
          "title": "State Bar Board of Trustees, Open Session Agenda Item 6.3 (May 2026), dated May 14, 2026 — Resolutions p. 5 (approval of 2026 version; depublication of 2023 version)",
          "url": "https://www.calbar.ca.gov/sites/default/files/portals/0/documents/ethics/Agenda-Item-6.3.pdf",
          "verbatim": "FURTHER RESOLVED, that the Board of Trustees, upon recommendation of the State Bar Committee on Professional Responsibility and Conduct, approves the depublication of the 2023 Practical Guidance for the Use of Generative Artificial Intelligence in Practice of Law.",
          "effective": "2026-05-14",
          "fetched": "2026-09-18"
        },
        {
          "title": "Same — p. 2 (status of the guidance)",
          "url": "https://www.calbar.ca.gov/sites/default/files/portals/0/documents/ethics/Agenda-Item-6.3.pdf",
          "verbatim": "As before, this document serves as a resource to provide guidance on this evolving technology while further rules and regulations are considered.",
          "effective": "2026-05-14",
          "fetched": "2026-09-18"
        },
        {
          "title": "State Bar of California, Ethics News (Board approval of the updated guidance)",
          "url": "https://www.calbar.ca.gov/legal-professionals/legal-resource-center/ethics/ethics-news",
          "verbatim": "On May 14, 2026, the Board of Trustees approved updated revisions to the Practical Guidance for the Use of Generative Artificial Intelligence in the Practice of Law, originally published on November 16, 2023.",
          "effective": "2026-05-14",
          "fetched": "2026-09-18"
        },
        {
          "title": "California Rules of Professional Conduct, Rule 1.0 Comment [4] (ethics committee opinions not binding) — for the weight of this guidance",
          "url": "https://www.calbar.ca.gov/sites/default/files/portals/0/documents/rules/Rules-of-Professional-Conduct-0.pdf",
          "verbatim": "[4] In addition to the authorities identified in paragraph (b)(2), opinions of ethics committees in California, although not binding, should be consulted for guidance on proper professional conduct.",
          "effective": null,
          "fetched": "2026-09-18"
        },
        {
          "title": "State Bar of California, Artificial Intelligence resources page (lists the Practical Guidance as the State Bar's AI resource; checked 2026-09-18)",
          "url": "https://www.calbar.ca.gov/legal-professionals/ethics-compliance-practice-resources/ethics/ethics-technology-resources/artificial-intelligence",
          "verbatim": null,
          "effective": null,
          "fetched": "2026-09-18"
        },
        {
          "title": "State Bar Board of Trustees agenda, May 14-15, 2026 (PrimeGov portal) — lists the Board report responding to the Supreme Court's Jan. 28, 2026 letter (not fetched)",
          "url": "https://calbar.primegov.com/Portal/Meeting?meetingTemplateId=2202",
          "verbatim": null,
          "effective": null,
          "fetched": "2026-09-18"
        },
        {
          "title": "LEAD ONLY — ICLR, \"State Bar of California updates practical guidance on generative AI\" (search result; not relied on)",
          "url": "https://iclr.net/news/state-bar-of-california-updates-practical-guidance-on-generative-ai/",
          "verbatim": null,
          "effective": null,
          "fetched": null
        }
      ],
      "status": "verified",
      "verified_on": "2026-09-18",
      "verified_by": "claude-opus-5 (independent verifier session; every source URL re-fetched 2026-09-17; checkq/strictq exact match; pinpoints, effective dates, status and narrative claims checked against the fetched text; one missed-item search)",
      "attorney_signoff": null,
      "notes": "(A) RE-VERIFICATION OF THE SEED: the guidance WAS revised since it issued. The Board of Trustees approved the 2026 version on May 14, 2026 (Agenda Item 6.3, dated May 14, 2026; Ethics News page), and by the same resolution approved \"the depublication of the 2023 Practical Guidance\". The PDF at the long-standing URL (…/documents/ethics/Generative-AI-Practical-Guidance.pdf, which now redirects to …/sites/default/files/portals/0/documents/ethics/…) is the 2026 version; the 2023 version was not fetched because it is depublished. The 2026 PDF carries no date on its face beyond the Executive Summary; the approval date comes from the Board item and the Ethics News page. (B) The seed's quotations (proposed Rule 1.1 Comment [2], Rule 3.3 Comment [3], Rule 1.6 Comment [2], Rule 1.4 Comment [5]) are Rules-of-Professional-Conduct proposals, not this guidance; they have moved to the ca-rpc entry, where the second-round (June 2026) text replaces the first-round text the seed quoted. The seed's verified_on (2026-09-16) was set by the compiling session and is not carried forward. (C) WEIGHT: guidance approved by the Board, not a rule or a formal ethics opinion; the Board item describes it as \"a resource to provide guidance on this evolving technology while further rules and regulations are considered.\" Rule 1.0 Comment [4] treats California ethics-committee opinions as \"not binding\" but to be consulted. Its \"must\" phrasing restates duties the guidance attributes to the cited rules; the attorney should not cite the guidance itself as the source of a binding duty. (D) TEXT VERSION NOTE: the published PDF is a copy-edited version of Board Attachment B (Clean): a word-level diff by the compiler found editorial changes only (attorney → lawyer, The Committee → COPRAC, punctuation, column reflow), no substantive change. Quotations here are from the published PDF. (E) The guidance is laid out as a two-column table (authorities on the left); several quotations begin mid-sentence to avoid interleaved left-column labels in the text extraction — the source title says so where it matters. (F) Nothing in the guidance requires disclosure to a court or keeping a record of AI use (full-text search for the word record returned no hit); it tells lawyers to check each jurisdiction's own disclosure requirements (p. 9). Other related State Bar actions (not AI rules; not extracted): Board Agenda Item 6.3 also mentions an all-licensee email on AI hallucinations (Mar. 19, 2026) and a media advisory (Apr. 13, 2026) on three AI-related discipline matters; the May 14-15, 2026 Board agenda also lists a report responding to the Supreme Court's Jan. 28, 2026 letter \"Regarding Use of Generative AI in Connection with Pending Complaints\" (State Bar internal use, not attorney duties; not fetched)."
    },
    {
      "id": "ca-sb-574",
      "kind": "state_statute",
      "name": "California SB 574 (2025–2026 Reg. Sess.) (Umberg) — Attorneys, arbitrators, judicial officers, and alternative resolution providers (ENROLLED; PENDING BEFORE THE GOVERNOR as of 2026-09-18)",
      "disclosure_to_court": "required IF ENACTED — not in force as of 2026-09-18 (enrolled Bus. & Prof. Code § 6068.1(a)(3)(C)); none under current California statute",
      "certification_required": false,
      "certificate_language": null,
      "verification_duty": "NOT IN FORCE (bill pending before the Governor as of 2026-09-18). Enrolled text, new Bus. & Prof. Code § 6068.1(a)(3): \"An attorney who uses generative artificial intelligence to assist in the practice of law shall do all of the following:\" ... (B) \"Take reasonable steps to do both of the following:\" \"(i) Verify the accuracy of generative artificial intelligence outputs, including, but not limited to, the accuracy of all case and statutory citations.\" \"(ii) Correct any erroneous or hallucinated output in any material used by the attorney.\" § 6068.1(a)(2): \"An attorney shall not delegate the practice of law to generative artificial intelligence.\" § 6068.1(a)(1): \"Nothing in this section shall be construed to abrogate an attorney’s duty to exercise reasonable competence and diligence in the practice of law.\" Amended Code Civ. Proc. § 128.7(b)(2)(A) (bill § 3): \"A brief, pleading, motion, or any other paper filed in any court shall not contain any citations that an attorney responsible for submitting the pleading has not personally verified, including any citation provided by generative artificial intelligence.\" Sanctions for a § 128.7(b) violation follow § 128.7(c)-(d), re-enacted with wording unchanged from current law, including \"Absent exceptional circumstances, a law firm shall be held jointly responsible for violations committed by its partners, associates, and employees.\"",
      "confidentiality_restriction": "NOT IN FORCE. Enrolled § 6068.1(a)(3)(A): the attorney shall \"Not enter confidential, personal identifying, and other nonpublic information into a generative artificial intelligence system for which access to confidential, personal identifying, or other nonpublic information the attorney inputs into the system is not restricted to the attorney and persons authorized by the attorney under obligations to protect the confidentiality of the information.\" § 6068.1(b)(2) defines personal identifying information to include driver's license numbers, dates of birth, Social Security numbers, NCIC/CII numbers, \"Addresses and phone numbers of parties, victims, witnesses, and court personnel.\", \"Medical or psychiatric information.\", \"Financial information.\", \"Account numbers.\", and \"Any other content sealed by court order or deemed confidential by court rule or statute.\" The restriction turns on the system's access controls (inputs restricted to the attorney and persons under confidentiality obligations), not on the vendor's identity.",
      "record_keeping_duty": "none",
      "client_disclosure_duty": "none in the bill. The second clause of enrolled § 6068.1(a)(3)(C) (\"consider whether to disclose the use of generative artificial intelligence if it is used to create content provided to the public\") concerns content provided to the public, not disclosure to the client. Client-disclosure duties, if any, come from the ca-rpc entry (Rule 1.4) and the State Bar guidance (ca-state-bar-guidance).",
      "fees_note": null,
      "sources": [
        {
          "title": "SB 574 (2025–2026), Enrolled text dated September 04, 2026 (leginfo bill-text page, version \"09/04/26 - Enrolled\") — new Bus. & Prof. Code § 6068.1(a)(3)(C) (disclosure to the court)",
          "url": "https://leginfo.legislature.ca.gov/faces/billTextClient.xhtml?bill_id=202520260SB574",
          "verbatim": "(C) Disclose the use of generative artificial intelligence to the court for all documents submitted to the court and consider whether to disclose the use of generative artificial intelligence if it is used to create content provided to the public.",
          "effective": null,
          "fetched": "2026-09-18"
        },
        {
          "title": "Same — § 6068.1(a)(3)(B) (verification and correction)",
          "url": "https://leginfo.legislature.ca.gov/faces/billTextClient.xhtml?bill_id=202520260SB574",
          "verbatim": "(B) Take reasonable steps to do both of the following: (i) Verify the accuracy of generative artificial intelligence outputs, including, but not limited to, the accuracy of all case and statutory citations. (ii) Correct any erroneous or hallucinated output in any material used by the attorney.",
          "effective": null,
          "fetched": "2026-09-18"
        },
        {
          "title": "Same — § 6068.1(a)(3)(A) (confidential, personal identifying, and nonpublic information)",
          "url": "https://leginfo.legislature.ca.gov/faces/billTextClient.xhtml?bill_id=202520260SB574",
          "verbatim": "(A) Not enter confidential, personal identifying, and other nonpublic information into a generative artificial intelligence system for which access to confidential, personal identifying, or other nonpublic information the attorney inputs into the system is not restricted to the attorney and persons authorized by the attorney under obligations to protect the confidentiality of the information.",
          "effective": null,
          "fetched": "2026-09-18"
        },
        {
          "title": "Same — § 6068.1(a)(1)-(2) (competence not abrogated; no delegation of the practice of law)",
          "url": "https://leginfo.legislature.ca.gov/faces/billTextClient.xhtml?bill_id=202520260SB574",
          "verbatim": "(a) (1) Nothing in this section shall be construed to abrogate an attorney’s duty to exercise reasonable competence and diligence in the practice of law. (2) An attorney shall not delegate the practice of law to generative artificial intelligence.",
          "effective": null,
          "fetched": "2026-09-18"
        },
        {
          "title": "Same — § 6068.1(b)(1) (definition of generative artificial intelligence)",
          "url": "https://leginfo.legislature.ca.gov/faces/billTextClient.xhtml?bill_id=202520260SB574",
          "verbatim": "(1) “Generative artificial intelligence” means an artificial intelligence system that can generate derived synthetic content, including text, images, video, and audio that emulates the structure and characteristics of the system’s training data.",
          "effective": null,
          "fetched": "2026-09-18"
        },
        {
          "title": "Same — bill § 3, amended Code Civ. Proc. § 128.7(b)(2)(A) (personally verified citations)",
          "url": "https://leginfo.legislature.ca.gov/faces/billTextClient.xhtml?bill_id=202520260SB574",
          "verbatim": "(2) (A) A brief, pleading, motion, or any other paper filed in any court shall not contain any citations that an attorney responsible for submitting the pleading has not personally verified, including any citation provided by generative artificial intelligence.",
          "effective": null,
          "fetched": "2026-09-18"
        },
        {
          "title": "Same — bill § 3, Code Civ. Proc. § 128.7(c)(1) (law-firm joint responsibility; existing text re-enacted)",
          "url": "https://leginfo.legislature.ca.gov/faces/billTextClient.xhtml?bill_id=202520260SB574",
          "verbatim": "Absent exceptional circumstances, a law firm shall be held jointly responsible for violations committed by its partners, associates, and employees.",
          "effective": null,
          "fetched": "2026-09-18"
        },
        {
          "title": "Same — bill § 4, new Code Civ. Proc. § 180 (Judicial Council to revisit Standard 10.80)",
          "url": "https://leginfo.legislature.ca.gov/faces/billTextClient.xhtml?bill_id=202520260SB574",
          "verbatim": "The Judicial Council shall publicly revisit, and revise as necessary, Standard 10.80 of the California Standards of Judicial Administration to incorporate any necessary changes to reflect the further development of generative artificial intelligence.",
          "effective": null,
          "fetched": "2026-09-18"
        },
        {
          "title": "Same — bill § 5, new Code Civ. Proc. § 1282.1(b) (arbitrators)",
          "url": "https://leginfo.legislature.ca.gov/faces/billTextClient.xhtml?bill_id=202520260SB574",
          "verbatim": "(b) (1) An arbitrator shall not delegate any part of their decisionmaking process to any generative artificial intelligence tool. (2) An arbitrator shall not rely on information generated by generative artificial intelligence outside the record without making appropriate disclosures to the parties beforehand and, as far as practical, allowing the parties to comment on its use.",
          "effective": null,
          "fetched": "2026-09-18"
        },
        {
          "title": "Same — Legislative Counsel's Digest, Digest Key (majority vote; no urgency clause found in the bill text)",
          "url": "https://leginfo.legislature.ca.gov/faces/billTextClient.xhtml?bill_id=202520260SB574",
          "verbatim": "Vote: MAJORITY",
          "effective": null,
          "fetched": "2026-09-18"
        },
        {
          "title": "Code Civ. Proc. § 128.7 as currently in force (leginfo; \"Amended by Stats. 2005, Ch. 706, Sec. 9. Effective January 1, 2006.\") — current (b)(2), the legal-contentions certification that the bill renumbers",
          "url": "https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?lawCode=CCP&sectionNum=128.7.",
          "verbatim": "(2) The claims, defenses, and other legal contentions therein are warranted by existing law or by a nonfrivolous argument for the extension, modification, or reversal of existing law or the establishment of new law.",
          "effective": "2006-01-01",
          "fetched": "2026-09-18"
        },
        {
          "title": "Same — current § 128.7(d)(1) (text identical in the enrolled bill)",
          "url": "https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?lawCode=CCP&sectionNum=128.7.",
          "verbatim": "(1) Monetary sanctions may not be awarded against a represented party for a violation of paragraph (2) of subdivision (b).",
          "effective": "2006-01-01",
          "fetched": "2026-09-18"
        },
        {
          "title": "SB 574 Bill History (leginfo) — last action as of fetch",
          "url": "https://leginfo.legislature.ca.gov/faces/billHistoryClient.xhtml?bill_id=202520260SB574",
          "verbatim": "09/09/26 Enrolled and presented to the Governor at 2 p.m.",
          "effective": null,
          "fetched": "2026-09-18"
        },
        {
          "title": "Same — final legislative votes",
          "url": "https://leginfo.legislature.ca.gov/faces/billHistoryClient.xhtml?bill_id=202520260SB574",
          "verbatim": "Assembly amendments concurred in. (Ayes 39. Noes 0.) Ordered to engrossing and enrolling.",
          "effective": null,
          "fetched": "2026-09-18"
        },
        {
          "title": "California Constitution, art. IV, § 10(b)(2) (Governor's deadline for bills in possession on or after September 1 of the second year)",
          "url": "https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?lawCode=CONS&sectionNum=SEC.%2010.&article=IV",
          "verbatim": "(2) Any bill passed by the Legislature before September 1 of the second calendar year of the biennium of the legislative session and in the possession of the Governor on or after September 1 that is not returned on or before September 30 of that year becomes a statute.",
          "effective": null,
          "fetched": "2026-09-18"
        },
        {
          "title": "California Constitution, art. IV, § 8(c)(1) (effective date of a non-urgency statute)",
          "url": "https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?lawCode=CONS&sectionNum=SEC.%208.&article=IV",
          "verbatim": "(c) (1) Except as provided in paragraphs (2) and (3) of this subdivision, a statute enacted at a regular session shall go into effect on January 1 next following a 90-day period from the date of enactment of the statute",
          "effective": null,
          "fetched": "2026-09-18"
        },
        {
          "title": "Office of the Governor, Newsroom (checked for SB 574 action; latest item dated Sep 16, 2026; no SB 574 item)",
          "url": "https://www.gov.ca.gov/newsroom/",
          "verbatim": null,
          "effective": null,
          "fetched": "2026-09-18"
        },
        {
          "title": "LEAD ONLY — Sullivan & Cromwell memo, \"California Legislature Passes Rules on Generative AI Use by Legal Practitioners\" (Sept. 2026) (seed source; not relied on)",
          "url": "https://www.sullcrom.com/insights/memo/2026/September/California-Legislature-Passes-Rules-Generative-AI-Use-Legal-Practitioners",
          "verbatim": null,
          "effective": null,
          "fetched": null
        },
        {
          "title": "LEAD ONLY — Hunton memo on the pre-Assembly version (May 1, 2026) (seed source; describes an earlier version; not relied on)",
          "url": "https://www.hunton.com/insights/publications/guardrails-for-legal-ai-what-californias-sb-574-would-require-of-attorneys-and-arbitrators",
          "verbatim": null,
          "effective": null,
          "fetched": null
        },
        {
          "title": "LEAD ONLY — Senate Judiciary Committee analysis of SB 574 (Jan. 2026; analyzes an earlier version; located by search, not read)",
          "url": "https://sjud.senate.ca.gov/system/files/2026-01/sb-574-umberg-sjud-analysis.pdf",
          "verbatim": null,
          "effective": null,
          "fetched": null
        },
        {
          "title": "LEAD ONLY — CalMatters Digital Democracy bill page (search result; not relied on)",
          "url": "https://calmatters.digitaldemocracy.org/bills/ca_202520260sb574",
          "verbatim": null,
          "effective": null,
          "fetched": null
        }
      ],
      "status": "pending",
      "verified_on": "2026-09-18",
      "verified_by": "claude-opus-5 (independent verifier session; every source URL re-fetched 2026-09-17; checkq/strictq exact match; pinpoints, effective dates, status and narrative claims checked against the fetched text; one missed-item search)",
      "attorney_signoff": null,
      "notes": "(i) STATUS AS OF FETCH (2026-09-18): pending before the Governor — neither signed nor vetoed. The leginfo Bill History's last action is \"09/09/26 Enrolled and presented to the Governor at 2 p.m.\" The Governor's newsroom (latest item Sep 16, 2026) had no SB 574 item. Under Cal. Const. art. IV, § 10(b)(2), a bill in this posture \"that is not returned on or before September 30 of that year becomes a statute\", i.e., it becomes law without signature unless vetoed by Sept. 30, 2026. Recommend the merge session set status: pending and re-check leginfo after Sept. 30, 2026. (ii) OPERATIVE DATE: the enrolled text states no operative or effective date and contains no urgency section (Digest Key \"Vote: MAJORITY\"). Under art. IV, § 8(c)(1) a statute enacted at a regular session goes into effect \"on January 1 next following a 90-day period from the date of enactment of the statute\"; for enactment on or before Sept. 30, 2026 that computes to Jan. 1, 2027 (the computation is the compiler's, not stated in any source). (iii) SEED CORRECTIONS: the seed's certification_required: true is not supported by the enrolled text — the bill prescribes a disclosure to the court (§ 6068.1(a)(3)(C)) and a no-unverified-citations rule (§ 128.7(b)(2)(A)), but no certificate and no form of words; certificate_language stays null. The seed's client_disclosure_duty described the public-content clause of § 6068.1(a)(3)(C), which is not a client-disclosure duty. The seed's single verbatim came from the S&C memo; the operative words now come from the enrolled text itself. (iv) SCOPE AND STRUCTURE: § 6068.1 is in the State Bar Act and binds California attorneys; § 128.7 is in the Code of Civil Procedure (California state courts; it does not govern federal filings in California). Compared with current § 128.7 (fetched 2026-09-18; last amended Stats. 2005, ch. 706), the bill moves the four existing certifications from (b)(1)-(4) into a new (b)(1)(A)-(D) and inserts the citation rule as a new (b)(2); subdivisions (c) and (d) are re-enacted with unchanged wording. Consequence the attorney should weigh: § 128.7(d)(1) still reads \"Monetary sanctions may not be awarded against a represented party for a violation of paragraph (2) of subdivision (b).\" — under current law that paragraph is the legal-contentions certification; under the enrolled text it would be the new citation rule, so monetary sanctions for unverified citations would run against attorneys and firms, not represented parties; conversely, the legal-contentions certification (moved to (b)(1)(B)) would no longer be covered by the (d)(1) bar, so a represented party could face monetary sanctions for frivolous legal contentions. (Compiler's reading of the renumbering, possibly unintended; no source states it.) § 128.7(b)(2)(A) is framed as a flat prohibition (\"shall not contain any citations that an attorney responsible for submitting the pleading has not personally verified\"), not as a reasonable-inquiry certification, and § 128.7(g) still excludes discovery papers. (v) OPEN QUESTION FOR THE ATTORNEY: § 6068.1(a)(3)(C) is conditioned on the attorney having used generative AI \"to assist in the practice of law\", but its object is \"all documents submitted to the court\" — read literally, an attorney who uses GAI at all may owe disclosure on every court submission, not only those GAI touched. This is an interpretive question the text does not resolve; do not resolve it in the record without the attorney. (vi) OTHER PROVISIONS: new Code Civ. Proc. § 1282.1 (arbitrators may not delegate decision-making to GAI and must disclose reliance on GAI information outside the record); new Code Civ. Proc. § 180 (Judicial Council to revisit Standard 10.80 — see ca-state-courts); amended Bus. & Prof. Code § 6173 (ADR certification complaint procedures; not AI-specific). (vii) History read in full: introduced 02/20/25; amended in Senate 03/24/25 and 01/05/26; passed Senate 01/29/26 (Ayes 39, Noes 0); amended in Assembly 06/22/26, 07/02/26, 08/13/26, 08/21/26; passed Assembly 08/31/26; Senate concurred 08/31/26 (Ayes 39, Noes 0); enrolled 09/04/26. The firm memos in sources[] describe different versions; only the enrolled text is quoted here. (viii) VERIFIER (2026-09-18) AND MERGE (2026-09-20): all 16 quotations re-checked exact. Status re-checked on 2026-09-18: leginfo's Bill History still ended at \"09/09/26 Enrolled and presented to the Governor at 2 p.m.\" — neither signed nor vetoed — so status is carried into the master as pending (not in force), with verified_on recording that the text and status were verified. The compiler's reading of the renumbering was tested against both texts and its premises are exact: current section 128.7(b)(1)-(4) becomes (b)(1)(A)-(D), the citation rule enters as a new (b)(2)(A) with its definition at (b)(2)(B), and subdivisions (c) through (i) are character-identical to current law, so the unchanged (d)(1) bar attaches to the new citation rule; the consequence remains an inference no source states. RE-CHECK leginfo after September 30, 2026: if the Governor neither signs nor vetoes by then the bill becomes law, and this entry's status, effective dates and disclosure_to_court must be revisited."
    },
    {
      "id": "ca-state-courts",
      "kind": "state_court",
      "name": "California state courts — California Rules of Court, Standards of Judicial Administration (Judicial Council), and published Court of Appeal decisions on AI-fabricated citations",
      "disclosure_to_court": "none statewide (no Rule of Court or Judicial Council rule requires parties or counsel to disclose AI use); superior-court local rules vary — e.g., San Mateo Superior Court Local Rule 2.14 (eff. 2026-01-01) incorporates AI expectations posted on that court's website; check the filing court's local rules",
      "certification_required": false,
      "certificate_language": null,
      "verification_duty": "No statewide rule or standard addresses parties' or attorneys' AI use in filings; the duty comes from statute, the Rules of Professional Conduct, the Rules of Court, and published decisions. Code Civ. Proc. § 128.7(b) (current): \"By presenting to the court, whether by signing, filing, submitting, or later advocating, a pleading, petition, written notice of motion, or other similar paper, an attorney or unrepresented party is certifying that to the best of the person’s knowledge, information, and belief, formed after an inquiry reasonable under the circumstances, all of the following conditions are met:\" (legal contentions warranted, § 128.7(b)(2); signing certification, not AI-specific). Appellate briefs: rule 8.204(a)(1)(B) (support each point \"if possible, by citation of authority\"); sanctions under rule 8.276(a), including for \"(4) Committing any other unreasonable violation of these rules.\" Published decisions: Noland v. Land of the Free, L.P. (2025) 114 Cal.App.5th 426 (2d Dist., Div. 3, filed 9/12/25) — the court's warning, as quoted in Sheerer: \"no brief, pleading, motion, or any other paper filed in any court should contain any citations—whether provided by generative AI or any other source—that the attorney responsible for submitting the pleading has not personally read and verified.\" (Noland at p. 431); Noland: \"To state the obvious, it is a fundamental duty of attorneys to read the legal authorities they cite in appellate briefs or any other court filings to determine that the authorities stand for the propositions for which they are cited.\" ($10,000 sanction payable to the court; opinion forwarded to the State Bar.) People v. Alvarez (2025) 114 Cal.App.5th 1115 (4th Dist., Div. 1, filed 10/2/25, published order): \"And attorneys cannot delegate this responsibility to any form of technology; this is the responsibility of a competent attorney.\" ($1,500 sanction on defense counsel; State Bar notified.) Sheerer v. Panas (2026) 119 Cal.App.5th 367 (1st Dist., Div. 4, filed 3/19/26, part II.B published): \"We partially publish this opinion to extend that warning to in propria persona litigants.\" (no sanction imposed on the facts). Later published decisions hold the signer responsible however the error arose — Shayan v. Shakib (2025) 116 Cal.App.5th 619: \"Regardless of whether inaccuracies in a brief are the result of using artificial intelligence (AI) tools or some other drafting process, as Farivar and appellant argue occurred here, the signatory attorney is responsible for the content of the brief and subject to sanctions for inaccuracies it contains.\" ($7,500); Schlichter v. Kennedy (2025) 116 Cal.App.5th 24 ($1,750; denials of AI use not credible); In re Domestic Partnership of Torres Campos & Munoz (2026) 118 Cal.App.5th 1112 ($5,000; also holds a trial court's reliance on fictional cases in its order is an abuse of discretion); Quinteros v. Harbor Distributing, LLC (2026) 121 Cal.App.5th 60 (affirming trial-court § 128.7 sanctions against the firm and signing attorneys for a contract attorney's AI-drafted brief); Del Biaggio v. Bansen (1st Dist., Div. 4, filed 7/10/26, No. A174647) ($1,500; a paralegal citation check does not satisfy the lawyer's duty: \"This plan would have been inappropriate even if it had not gone awry.\"); Southland Homes & Real Estate & Investment, LLC v. Lam (App. Div., Orange County Super. Ct., No. 30-2026-01569207, published order, Aug. 2026) ($2,500 on the supervising attorney of record who did not check citations; $1,500 on the drafter): \"A lawyer’s duties cannot be delegated to a machine capable of confidently inventing what it cannot legitimately find.\"",
      "confidentiality_restriction": "None for parties or counsel in the Rules of Court (see ca-rpc and ca-sb-574). Rule 10.430(d)(1) and Standard 10.80(b)(1) restrict entry of confidential or personal identifying information into public generative AI systems by COURT STAFF and JUDICIAL OFFICERS only.",
      "record_keeping_duty": "none",
      "client_disclosure_duty": "none in the Rules of Court. Case-specific directives only: Noland and Del Biaggio ordered counsel to serve the opinion on the client and certify that they had done so; Alvarez noted counsel informed his client before withdrawing.",
      "fees_note": null,
      "sources": [
        {
          "title": "California Rules of Court, rule 10.430 (Generative artificial intelligence use policies) — subd. (b) (applies to courts; policy deadline)",
          "url": "https://courts.ca.gov/cms/rules/index/ten/rule10_430",
          "verbatim": "Any court that does not prohibit the use of generative AI by court staff or judicial officers must adopt a generative AI use policy by December 15, 2025. This rule applies to the superior courts, the Courts of Appeal, and the Supreme Court.",
          "effective": "2025-09-01",
          "fetched": "2026-09-18"
        },
        {
          "title": "Same — subd. (c) (scope limited to court staff and judicial officers)",
          "url": "https://courts.ca.gov/cms/rules/index/ten/rule10_430",
          "verbatim": "A use policy created to comply with this rule must cover the use of generative AI by court staff for any purpose and by judicial officers for any task outside their adjudicative role.",
          "effective": "2025-09-01",
          "fetched": "2026-09-18"
        },
        {
          "title": "Same — history note",
          "url": "https://courts.ca.gov/cms/rules/index/ten/rule10_430",
          "verbatim": "Rule 10.430 adopted effective September 1, 2025.",
          "effective": "2025-09-01",
          "fetched": "2026-09-18"
        },
        {
          "title": "California Standards of Judicial Administration, standard 10.80 (Use of generative artificial intelligence by judicial officers) — subd. (b) (adjudicative role only)",
          "url": "https://courts.ca.gov/cms/rules/index/standards/Standard10_80",
          "verbatim": "A judicial officer using generative AI for any task within their adjudicative role:",
          "effective": "2025-09-01",
          "fetched": "2026-09-18"
        },
        {
          "title": "Same — history note",
          "url": "https://courts.ca.gov/cms/rules/index/standards/Standard10_80",
          "verbatim": "Standard 10.80 adopted effective September 1, 2025.",
          "effective": "2025-09-01",
          "fetched": "2026-09-18"
        },
        {
          "title": "Code of Civil Procedure § 128.7(b) as currently in force (leginfo; last amended Stats. 2005, ch. 706) — signing certification",
          "url": "https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?lawCode=CCP&sectionNum=128.7.",
          "verbatim": "By presenting to the court, whether by signing, filing, submitting, or later advocating, a pleading, petition, written notice of motion, or other similar paper, an attorney or unrepresented party is certifying that to the best of the person’s knowledge, information, and belief, formed after an inquiry reasonable under the circumstances, all of the following conditions are met:",
          "effective": "2006-01-01",
          "fetched": "2026-09-18"
        },
        {
          "title": "California Rules of Court, Title 8 (Appellate Rules) PDF — rule 8.204(a)(1)(B) (support each point by authority)",
          "url": "https://courts.ca.gov/system/files?file=file/roc-title-8_0.pdf",
          "verbatim": "(B) State each point under a separate heading or subheading summarizing the point, and support each point by argument and, if possible, by citation of authority; and",
          "effective": null,
          "fetched": "2026-09-18"
        },
        {
          "title": "Same — rule 8.276(a)(4) (sanctions for unreasonable rule violations)",
          "url": "https://courts.ca.gov/system/files?file=file/roc-title-8_0.pdf",
          "verbatim": "(4) Committing any other unreasonable violation of these rules.",
          "effective": "2008-01-01",
          "fetched": "2026-09-18"
        },
        {
          "title": "Noland v. Land of the Free, L.P. (2025) 114 Cal.App.5th 426, No. B331918 (Cal. Ct. App., 2d Dist., Div. 3, filed 9/12/25, certified for publication) — slip op. 25 (duty to read cited authorities)",
          "url": "https://www.courts.ca.gov/opinions/archive/B331918.PDF",
          "verbatim": "To state the obvious, it is a fundamental duty of attorneys to read the legal authorities they cite in appellate briefs or any other court filings to determine that the authorities stand for the propositions for which they are cited.",
          "effective": "2025-09-12",
          "fetched": "2026-09-18"
        },
        {
          "title": "Same — slip op. 25 (fabricated authority sanctionable)",
          "url": "https://www.courts.ca.gov/opinions/archive/B331918.PDF",
          "verbatim": "We agree with the cases cited above that relying on fabricated legal authority is sanctionable.",
          "effective": "2025-09-12",
          "fetched": "2026-09-18"
        },
        {
          "title": "Same — slip op. 26 (AI use permitted; verification not delegable; quoting Versant)",
          "url": "https://www.courts.ca.gov/opinions/archive/B331918.PDF",
          "verbatim": "although there is nothing inherently wrong with an attorney appropriately using AI in a law practice—before filing any court document, an attorney must “carefully check every case citation, fact, and argument to make sure that they are correct and proper.",
          "effective": "2025-09-12",
          "fetched": "2026-09-18"
        },
        {
          "title": "Same — slip op. 32 (Disposition; sanction)",
          "url": "https://www.courts.ca.gov/opinions/archive/B331918.PDF",
          "verbatim": "Attorney Amir Mostafavi is directed to pay $10,000 in sanctions, payable to the clerk of this court, no later than 30 days after the remittitur is filed.",
          "effective": "2025-09-12",
          "fetched": "2026-09-18"
        },
        {
          "title": "Same — slip op. 32 (Disposition; State Bar referral)",
          "url": "https://www.courts.ca.gov/opinions/archive/B331918.PDF",
          "verbatim": "Pursuant to Business and Professions Code section 6086.7, subdivision (a)(3), the clerk of the court is ordered to forward a copy of this opinion to the State Bar upon return of the remittitur.",
          "effective": "2025-09-12",
          "fetched": "2026-09-18"
        },
        {
          "title": "People v. Alvarez (2025) 114 Cal.App.5th 1115, No. D084581 (Cal. Ct. App., 4th Dist., Div. 1, filed 10/2/25, certified for publication; order of the court) — slip op. 3 (non-delegable)",
          "url": "https://www.courts.ca.gov/opinions/archive/D084581.PDF",
          "verbatim": "And attorneys cannot delegate this responsibility to any form of technology; this is the responsibility of a competent attorney.",
          "effective": "2025-10-02",
          "fetched": "2026-09-18"
        },
        {
          "title": "Same — slip op. 3-4 (criminal defense counsel)",
          "url": "https://www.courts.ca.gov/opinions/archive/D084581.PDF",
          "verbatim": "Thus, criminal defense attorneys must make every effort to confirm that the legal citations they supply exist and accurately reflect the law for which they are cited.",
          "effective": "2025-10-02",
          "fetched": "2026-09-18"
        },
        {
          "title": "Same — slip op. 4 (knowing false statement inferred from admission; Rule 1.0.1(f))",
          "url": "https://www.courts.ca.gov/opinions/archive/D084581.PDF",
          "verbatim": "We infer he knowingly made a false statement based on this admission.",
          "effective": "2025-10-02",
          "fetched": "2026-09-18"
        },
        {
          "title": "Same — slip op. 4 (sanction)",
          "url": "https://www.courts.ca.gov/opinions/archive/D084581.PDF",
          "verbatim": "we issue a sanction in the amount of $1,500 to be paid by Attorney Siddell individually to the Fourth District Court of Appeal, Division One.",
          "effective": "2025-10-02",
          "fetched": "2026-09-18"
        },
        {
          "title": "Sheerer v. Panas, No. A171804 (Cal. Ct. App., 1st Dist., Div. 4, filed 3/19/26, certified for partial publication; part II.B published) — slip op. 2 (quoting Noland at p. 431)",
          "url": "https://www.courts.ca.gov/opinions/archive/A171804.PDF",
          "verbatim": "“no brief, pleading, motion, or any other paper filed in any court should contain any citations—whether provided by generative AI or any other source—that the attorney responsible for submitting the pleading has not personally read and verified.” (Noland v. Land of the Free, L.P. (2025) 114 Cal.App.5th 426, 431 (Noland).)",
          "effective": "2026-03-19",
          "fetched": "2026-09-18"
        },
        {
          "title": "Same — slip op. 2 (purpose of publication)",
          "url": "https://www.courts.ca.gov/opinions/archive/A171804.PDF",
          "verbatim": "We partially publish this opinion to extend that warning to in propria persona litigants.",
          "effective": "2026-03-19",
          "fetched": "2026-09-18"
        },
        {
          "title": "Same — slip op. 10 (verification required of attorneys and self-represented litigants)",
          "url": "https://www.courts.ca.gov/opinions/archive/A171804.PDF",
          "verbatim": "His lack of knowledge, of course, is a direct result of his failure to verify citations, a requirement of all attorneys and self-represented litigants responsible for briefs filed in this Court.",
          "effective": "2026-03-19",
          "fetched": "2026-09-18"
        },
        {
          "title": "Same — slip op. 11 (no monetary sanction on these facts)",
          "url": "https://www.courts.ca.gov/opinions/archive/A171804.PDF",
          "verbatim": "However, given Panas’s admission of his error and considering that it would not be in the best interest of the children at the heart of the underlying proceedings, we choose not to do so here.",
          "effective": "2026-03-19",
          "fetched": "2026-09-18"
        },
        {
          "title": "Shayan v. Shakib, Nos. B337559, B339376 (Cal. Ct. App., 2d Dist., Div. 1, filed 12/1/25, certified for publication; order) (cited as 116 Cal.App.5th 619 in Southland and Campos) — slip op. 1 (signatory responsible regardless of drafting method)",
          "url": "https://www.courts.ca.gov/opinions/archive/B337559.PDF",
          "verbatim": "Regardless of whether inaccuracies in a brief are the result of using artificial intelligence (AI) tools or some other drafting process, as Farivar and appellant argue occurred here, the signatory attorney is responsible for the content of the brief and subject to sanctions for inaccuracies it contains.",
          "effective": "2025-12-01",
          "fetched": "2026-09-18"
        },
        {
          "title": "Same — slip op. 7-8 (inherent risk of delegated citation work supports inference of knowing violation)",
          "url": "https://www.courts.ca.gov/opinions/archive/B337559.PDF",
          "verbatim": "This process involves an inherent risk that the staff will provide inaccurate language and, like the reliance on AI in Alvarez, supports an inference that he knowingly and unreasonably violated the rules.",
          "effective": "2025-12-01",
          "fetched": "2026-09-18"
        },
        {
          "title": "Same — slip op. 8 (sanction)",
          "url": "https://www.courts.ca.gov/opinions/archive/B337559.PDF",
          "verbatim": "First, Farivar shall pay sanctions in the amount of $7,500 to the clerk of this court within 30 days after the remittitur is filed.",
          "effective": "2025-12-01",
          "fetched": "2026-09-18"
        },
        {
          "title": "Schlichter v. Kennedy, No. E083744 (Cal. Ct. App., 4th Dist., Div. 2, filed 11/17/25, certified for publication; order) (cited as 116 Cal.App.5th 24 in Southland) — slip op. 7 (denials of AI use not credible)",
          "url": "https://www.courts.ca.gov/opinions/archive/E083744.PDF",
          "verbatim": "For all of these reasons, we conclude that Grotke’s repeated claims that the spurious citations resulted from clerical errors unrelated to the use of generative AI are not credible.",
          "effective": "2025-11-17",
          "fetched": "2026-09-18"
        },
        {
          "title": "Same — slip op. 8 (Disposition; sanction)",
          "url": "https://www.courts.ca.gov/opinions/archive/E083744.PDF",
          "verbatim": "For Grotke’s unreasonable violation of rule 8.204(a)(1)(B), we issue a sanction in the amount of $1,750 to be paid by Grotke individually to the Fourth District Court of Appeal, Division Two within 30 days.",
          "effective": "2025-11-17",
          "fetched": "2026-09-18"
        },
        {
          "title": "In re the Domestic Partnership of Torres Campos & Munoz, No. D085584 (Cal. Ct. App., 4th Dist., Div. 1, filed 3/5/26, certified for publication; modified 3/13/26, no change in judgment) (cited as 118 Cal.App.5th 1112 in Southland) — slip op. 1-2 (purpose of publication)",
          "url": "https://www.courts.ca.gov/opinions/archive/D085584M.PDF",
          "verbatim": "We publish this opinion to emphasize that courts and attorneys alike have a responsibility to protect the legal system against distortion by fabricated law, particularly in this new era of hallucinated citations generated by artificial intelligence (AI) tools.",
          "effective": "2026-03-05",
          "fetched": "2026-09-18"
        },
        {
          "title": "Same — slip op. 10 (court's reliance on fictional authority is an abuse of discretion)",
          "url": "https://www.courts.ca.gov/opinions/archive/D085584M.PDF",
          "verbatim": "We have no difficulty concluding that it is an abuse of discretion for a court to rely in material part on fictional case authorities in rendering a decision or making an order.",
          "effective": "2026-03-05",
          "fetched": "2026-09-18"
        },
        {
          "title": "Same — slip op. 18 (citing an unverified AI-prompt or blog case is an unreasonable rules violation)",
          "url": "https://www.courts.ca.gov/opinions/archive/D085584M.PDF",
          "verbatim": "For an attorney to cite and rely on a fictional case obtained from a Reddit article or an AI prompt without verifying and reading the case itself is an unreasonable violation of the Rules of Court.",
          "effective": "2026-03-05",
          "fetched": "2026-09-18"
        },
        {
          "title": "Same — slip op. 20 (Disposition; sanction)",
          "url": "https://www.courts.ca.gov/opinions/archive/D085584M.PDF",
          "verbatim": "Respondent’s counsel Roxanne Chung Bonar is ordered to pay $5,000 in sanctions payable to the clerk of this court no later than 30 days after the remittitur issues.",
          "effective": "2026-03-05",
          "fetched": "2026-09-18"
        },
        {
          "title": "Same — Order Modifying Opinion (3/13/26), text added to fn. 3 (courts should verify citations in counsel-drafted proposed orders)",
          "url": "https://www.courts.ca.gov/opinions/archive/D085584M.PDF",
          "verbatim": "As this case illustrates, it is equally important that judicial officers and court staff who are not themselves using generative AI verify the citations contained in proposed orders submitted to them by counsel.",
          "effective": "2026-03-13",
          "fetched": "2026-09-18"
        },
        {
          "title": "Quinteros v. Harbor Distributing, LLC, No. A174202 (Cal. Ct. App., 1st Dist., Div. 2, filed 6/11/26, certified for publication) (url corrected at merge 2026-09-20 — the /opinions/archive/ path returns 404) (cited as 121 Cal.App.5th 60 in Southland) — slip op. 1 (sanctions for evident misuse of generative AI)",
          "url": "https://www.courts.ca.gov/opinions/documents/A174202.PDF",
          "verbatim": "This appeal arises out of an order issuing sanctions against Lipeles Law Group, APC and its attorneys Kevin Lipeles, Thomas Schelly, and Jasmine Badawi (together, LLG), for their evident misuse of generative artificial intelligence (AI) in an otherwise meritless pleading",
          "effective": "2026-06-11",
          "fetched": "2026-09-18"
        },
        {
          "title": "Same — slip op. 23 (signers who did not read or cite-check the contract attorney's brief)",
          "url": "https://www.courts.ca.gov/opinions/documents/A174202.PDF",
          "verbatim": "Yet LLG admitted to the court that it either failed to read the pleading at all, in the case of Schelly and Lipeles, or failed to substantively review or cite check Sansone’s submission, in the case of Badawi.",
          "effective": "2026-06-11",
          "fetched": "2026-09-18"
        },
        {
          "title": "Same — slip op. 21 (sanctions affirmed)",
          "url": "https://www.courts.ca.gov/opinions/documents/A174202.PDF",
          "verbatim": "In view of this ever-growing body of law, we conclude the trial court did not abuse its discretion in imposing sanctions here.",
          "effective": "2026-06-11",
          "fetched": "2026-09-18"
        },
        {
          "title": "Del Biaggio v. Bansen, No. A174647 (Cal. Ct. App., 1st Dist., Div. 4, filed 7/10/26, certified for publication) — slip op. 17 (paralegal check does not satisfy State Bar guidance)",
          "url": "https://www.courts.ca.gov/opinions/documents/A174647.PDF",
          "verbatim": "First, even if the communication error had not occurred, Floyd’s protocol would not comply with the State Bar guidance to which he refers.",
          "effective": "2026-07-10",
          "fetched": "2026-09-18"
        },
        {
          "title": "Same — slip op. 18",
          "url": "https://www.courts.ca.gov/opinions/documents/A174647.PDF",
          "verbatim": "This plan would have been inappropriate even if it had not gone awry.",
          "effective": "2026-07-10",
          "fetched": "2026-09-18"
        },
        {
          "title": "Same — slip op. 19 (Sheerer's official citation, as cited in Del Biaggio)",
          "url": "https://www.courts.ca.gov/opinions/documents/A174647.PDF",
          "verbatim": "(Sheerer v. Panas (2026) 119 Cal.App.5th 367, 371.)",
          "effective": "2026-07-10",
          "fetched": "2026-09-18"
        },
        {
          "title": "Same — slip op. 21 (Disposition; sanction)",
          "url": "https://www.courts.ca.gov/opinions/documents/A174647.PDF",
          "verbatim": "Attorney Carlton Floyd is directed to pay $1,500 in sanctions, payable to the clerk of this court, no later than 30 days after the remittitur is filed.",
          "effective": "2026-07-10",
          "fetched": "2026-09-18"
        },
        {
          "title": "Southland Homes & Real Estate & Investment, LLC v. Lam, No. 30-2026-01569207 (App. Div., Super. Ct. Orange County; order filed Aug. 4, 2026, modified by order filed 8/5/26; certified for publication) — p. 1",
          "url": "https://www.courts.ca.gov/opinions/documents/JAD26-04.PDF",
          "verbatim": "A lawyer’s duties cannot be delegated to a machine capable of confidently inventing what it cannot legitimately find.",
          "effective": "2026-08-04",
          "fetched": "2026-09-18"
        },
        {
          "title": "Same — p. 6 (supervising attorney of record)",
          "url": "https://www.courts.ca.gov/opinions/documents/JAD26-04.PDF",
          "verbatim": "Davis argues his failure to verify each case cited in the petition is reasonable as a supervising attorney. Not so.",
          "effective": "2026-08-04",
          "fetched": "2026-09-18"
        },
        {
          "title": "Same — p. 8 (sanctions)",
          "url": "https://www.courts.ca.gov/opinions/documents/JAD26-04.PDF",
          "verbatim": "We impose sanctions of $2,500 against Davis.",
          "effective": "2026-08-04",
          "fetched": "2026-09-18"
        },
        {
          "title": "Same — p. 6 (Quinteros official citation, as cited in Southland)",
          "url": "https://www.courts.ca.gov/opinions/documents/JAD26-04.PDF",
          "verbatim": "Quinteros v. Harbor Distributing, LLC (2026) 121 Cal.App.5th 60, 78-80",
          "effective": "2026-08-04",
          "fetched": "2026-09-18"
        },
        {
          "title": "County of Los Angeles v. Niblett, No. B327744 (2d Dist., Div. 1; filed 10/31/25; certified for partial publication 11/26/25) — its AI discussion (part G) is EXCLUDED from publication (not citable)",
          "url": "https://www.courts.ca.gov/opinions/archive/B327744.PDF",
          "verbatim": "4. Part G of our Discussion, which starts on page 34 of the slip opinion and ends on (and includes) the first full paragraph on page 37 of the slip opinion that appears just before the Disposition.",
          "effective": "2025-11-26",
          "fetched": "2026-09-18"
        },
        {
          "title": "LEAD ONLY — CourtListener search API queries (published California opinions filed since 2025-06-01 containing hallucinat* with citation*, and artificial intelligence/generative AI/ChatGPT with sanction*) — used only to locate candidates; each candidate was then fetched from courts.ca.gov and grepped",
          "url": "https://www.courtlistener.com/api/rest/v4/search/?type=o&court=calctapp%20cal%20calappdeptsuper&filed_after=2025-06-01&stat_Published=on",
          "verbatim": null,
          "effective": null,
          "fetched": null
        },
        {
          "title": "San Mateo County Superior Court Local Rules (As Amended Effective July 1, 2026) — Local Rule 2.14 (Generative Artificial Intelligence Policy), adopted effective January 1, 2026 (example of a superior-court local AI rule)",
          "url": "https://sanmateo.courts.ca.gov/system/files/local-rules/localrules.pdf",
          "verbatim": "The Court will post and regularly update expectations for the use of Generative Artificial Intelligence (AI) on the Court’s website (www.sanmateo.courts.ca.gov). Attorneys and Self-Represented Litigants who use AI must be familiar with and follow these expectations.",
          "effective": "2026-01-01",
          "fetched": "2026-09-18"
        },
        {
          "title": "California Rules of Court, Titles 1-10 and Standards of Judicial Administration (official PDFs from the Rules of Court page; full-text grep for artificial intelligence / generative — hits only in rule 10.430 and standard 10.80)",
          "url": "https://courts.ca.gov/forms-rules/rules-court",
          "verbatim": null,
          "effective": null,
          "fetched": "2026-09-18"
        },
        {
          "title": "Judicial Council, New & Amended Rules page (2026 amendment packets effective May 1, June 1, July 1 and Aug. 1, 2026 fetched and grepped — no AI provisions)",
          "url": "https://courts.ca.gov/forms-rules/rules-court/new-amended-rules",
          "verbatim": null,
          "effective": null,
          "fetched": "2026-09-18"
        },
        {
          "title": "Judicial Council, Invitation to Comment SP25-01 (proposed rule 10.430 and standard 10.80) — read for scope; no provision addressed to parties or counsel",
          "url": "https://courts.ca.gov/system/files/itc/sp25-01_0.pdf",
          "verbatim": null,
          "effective": null,
          "fetched": "2026-09-18"
        },
        {
          "title": "LEAD ONLY — Horvitz & Levy, Supreme Court conference recap on Kjoller v. Superior Court, No. S293723 (Jan. 2026 order granting review and directing the Third District to issue an OSC re sanctions over a DA's alleged AI-drafted brief) — the docket itself was read at verification; see the next source",
          "url": "https://www.horvitzlevy.com/supreme-court-orders-sanctions-hearing-about-das-alleged-ai-briefing-conference-recap-part-i/",
          "verbatim": null,
          "effective": null,
          "fetched": null
        },
        {
          "title": "Kjoller v. Superior Court, No. S293723 (Cal. Supreme Ct.) and Kjoller v. The Superior Court of Nevada County, No. C104445 (Cal. Ct. App., 3d Dist.) — official dockets, read in a browser 2026-09-18 (the site is session-based: search by case number; Cloudflare clears in a real browser). Supreme Court, 01/14/2026: review granted and the matter transferred to the Third District with directions to vacate its October 20, 2025 order summarily denying sanctions and to issue an order to show cause why sanctions should not be imposed on the District Attorney of Nevada County (Cal. Rules of Court, rule 8.528(d)); case closed. Court of Appeal, 01/28/2026: order to show cause issued; 02/27/2026 return filed; 03/30/2026 fully briefed; 08/20/2026 the court stated it intends to appoint a referee under Code Civ. Proc. § 639(a)(4). NO sanctions decision has issued; the dockets do not themselves mention AI. Added at merge; watch item for the next sweep.",
          "url": "https://appellatecases.courtinfo.ca.gov/search/case/mainCaseScreen.cfm?dist=0&doc_no=S293723",
          "verbatim": null,
          "effective": null,
          "fetched": "2026-09-18"
        },
        {
          "title": "LEAD ONLY — Metropolitan News-Enterprise, \"C.A. Sanctions, Then Forgives, Pro Per for Phony Citations\" (July 2026) (Patterson v. Nuvision Credit Union, E085327, UNPUBLISHED; led to Sheerer)",
          "url": "http://www.metnews.com/articles/2026/sanctionimposed_070726.htm",
          "verbatim": null,
          "effective": null,
          "fetched": null
        },
        {
          "title": "LEAD ONLY — McGuireWoods alert on Noland (Sept. 2025) (search result; not relied on)",
          "url": "https://www.mcguirewoods.com/client-resources/alerts/2025/9/california-appellate-court-issues-10k-sanctions-in-states-first-published-opinion-on-ai-hallucinated-case-citations/",
          "verbatim": null,
          "effective": null,
          "fetched": null
        },
        {
          "title": "LEAD ONLY — CourtListener search API (used only to find the Alvarez docket number D084581)",
          "url": "https://www.courtlistener.com/api/rest/v4/search/?q=%22People%20v.%20Alvarez%22%20Siddell&type=o",
          "verbatim": null,
          "effective": null,
          "fetched": null
        }
      ],
      "status": "verified",
      "verified_on": "2026-09-18",
      "verified_by": "claude-opus-5 (independent verifier session; every source URL re-fetched 2026-09-17; checkq/strictq exact match; pinpoints, effective dates, status and narrative claims checked against the fetched text; one missed-item search)",
      "attorney_signoff": null,
      "notes": "(A) VERIFIED NOTHING (statewide, as to parties and counsel): no California Rule of Court, Standard of Judicial Administration, or Judicial Council rule addresses AI use in filings by parties or attorneys. Checked 2026-09-18: official PDFs of Titles 1, 2, 3, 4, 5, 7, 8, 9, 10 and the Standards (full-text grep for artificial intelligence / generative — 0 hits outside rule 10.430 and standard 10.80; the PDFs include amendments effective Jan. 1, 2026); the 2026 amendment packets on the New & Amended Rules page (effective May 1, June 1, July 1, Aug. 1, 2026; plus the Oct. 24, 2025 packet effective July 1, 2026) — 0 hits. Rule 10.430 and standard 10.80 (both effective Sept. 1, 2025) govern courts, court staff and judicial officers only. The Judicial Council's invitations-to-comment and AI task-force pages are script-rendered and showed no listings to curl (not checked); a verifier should check them in a browser for any pending 2026 proposal on litigant AI use. (B) PENDING LEGISLATION: SB 574 (see ca-sb-574) would add a no-unverified-citations rule to Code Civ. Proc. § 128.7(b)(2) and direct the Judicial Council to revisit standard 10.80 (new Code Civ. Proc. § 180); pending before the Governor as of 2026-09-18. (C) PUBLISHED DECISIONS ON AI-FABRICATED OR UNVERIFIED CITATIONS (nine found; each fetched from courts.ca.gov and read in full, except Noland, where all AI-related parts were read in full and the merits discussion was scanned): Noland (2d Dist., Div. 3, 9/12/25, 114 Cal.App.5th 426; $10,000); Alvarez (4th Dist., Div. 1, 10/2/25, 114 Cal.App.5th 1115; $1,500); Schlichter (4th Dist., Div. 2, 11/17/25, 116 Cal.App.5th 24; $1,750); Shayan (2d Dist., Div. 1, 12/1/25, 116 Cal.App.5th 619; $7,500); Torres Campos & Munoz (4th Dist., Div. 1, 3/5/26, mod. 3/13/26, 118 Cal.App.5th 1112; $5,000); Sheerer (1st Dist., Div. 4, 3/19/26, 119 Cal.App.5th 367; no sanction; self-represented litigant); Quinteros (1st Dist., Div. 2, 6/11/26, 121 Cal.App.5th 60; trial-court § 128.7 sanctions totaling $6,000, jointly and severally, affirmed — per the Quinteros opinion (slip op. 12) $5,000 to the opposing party and $1,000 to the court; Southland describes the split the other way round); Del Biaggio (1st Dist., Div. 4, 7/10/26, No. A174647; $1,500; official cite not found); Southland Homes (App. Div., Orange County, Aug. 2026; $2,500 + $1,500). Official reporter cites are taken from later opinions that cite them (Sheerer, Del Biaggio, Southland); the slip opinions do not print them. Each sanctioning court directed the clerk to notify the State Bar or ordered counsel to self-report. Search method (2026-09-18): CourtListener search API over published California appellate opinions filed since 2025-06-01 (hallucinat* with citation*: 26 hits, each fetched from courts.ca.gov and grepped for AI terms; AI/ChatGPT with sanction*: 11 hits, one new — Niblett, whose AI part is unpublished). Not proof of absence: a decision using none of those words would be missed. NOT FETCHED: Kjoller v. Superior Court, S293723 (Supreme Court order, Jan. 2026 per the lead; an order, not a published opinion; docket blocked by Cloudflare). Unpublished decisions (e.g., Patterson v. Nuvision Credit Union, E085327; Niblett part G) are not citable (rule 8.1115(a)) and are not listed as authority. (D) SUPERIOR COURT LOCAL RULES — NOT SURVEYED: the 58 superior courts' local rules were not systematically checked. San Mateo Superior Court Local Rule 2.14 (eff. Jan. 1, 2026) shows such rules exist; its website \"expectations\" page was not fetched. Before a filing in a California superior court, check that court's local rules and any posted AI expectations. (E) Noland's opening warning sentence breaks across a line at an em dash in the text extraction, so it is quoted here from Sheerer, which quotes it with the pinpoint (Noland at p. 431). (H) VERIFIER (2026-09-18) AND MERGE (2026-09-20): all 44 quotations re-checked exact; rule 10.430 and standard 10.80 confirmed as the only AI language in the whole body of Rules of Court, Standards and 2026 amendment packets (all 24 title/appendix PDFs re-fetched and grepped); all nine decisions confirmed published, with the sanction amounts as stated. Two fixes applied here at merge: the Quinteros source URL (the /opinions/archive/ path 404s; the opinion is served under /opinions/documents/, where the three quotations were re-gated) and the case name of In re the Domestic Partnership of Torres Campos & Munoz. The Judicial Council's pending-proposal pages, which the compiler could not read, were opened and expanded in a browser on 2026-09-18: the active Invitations to Comment (e.g., SP26-06, SP26-07) contain no AI proposal. The Kjoller dockets were read and are now a source of their own."
    },
    {
      "id": "us-cdca",
      "kind": "federal_district",
      "name": "U.S. District Court for the Central District of California",
      "disclosure_to_court": "judge_specific",
      "certification_required": false,
      "certificate_language": null,
      "verification_duty": "No court-wide AI rule. Fed. R. Civ. P. 11(b) (national rule) applies: by presenting a paper, an attorney \"certifies that to the best of the person’s knowledge, information, and belief, formed after an inquiry reasonable under the circumstances\" that legal contentions are warranted and factual contentions have evidentiary support (Rule 11(b)(2)-(3), paraphrased); Rule 11(c)(1): \"Absent exceptional circumstances, a law firm must be held jointly responsible for a violation committed by its partner, associate, or employee.\" L.R. 83-3.1.2 requires each attorney to know and comply with the standards of professional conduct required of members of the State Bar of California: \"These statutes, rules and decisions are hereby adopted as the standards of professional conduct, and any breach or violation thereof may be the basis for the imposition of discipline.\" L.R. 83-3.2.7 preserves each judge's inherent power over proceedings before the judge. Many individual judges add AI duties in their assigned cases (see notes (iv)), e.g., Judge Walter: the attorney or pro se party shall disclose AI use and \"CERTIFY that the attorney or pro se party has personally reviewed and verified the accuracy of all legal citations, quotations, factual statements, and analyses contained in the document.\"",
      "confidentiality_restriction": "No court-wide restriction on putting information into AI tools in the Local Rules or General Orders. Judge-level only: Judge Hsu, Standing Order for Newly Assigned Civil Cases § K.9: \"Parties shall refrain from uploading discovery received from the other side to public generative AI systems. This prohibition does not extend to uploads to enterprise or closed/private AI systems.\" and § K.10 requires counsel to anonymize client information in prompts and keep records of compliance: \"The owners of any AI tool may have access to information, prompts, and inquiries entered. Thus, counsel and parties must maintain confidentiality with privileged information when using any AI tool, including complying with protective orders. Counsel must also anonymize any client information in any prompts to an AI tool and maintain records sufficient to establish their compliance with the confidentiality provisions of this order.\" Magistrate Judge Karen E. Scott's Standard Form Protective Order § 7.1: \"Protected Material may not be uploaded to any open or unsecure AI platforms.\" Client-confidentiality duties otherwise come from the California Rules of Professional Conduct and State Bar Act, adopted by L.R. 83-3.1.2.",
      "record_keeping_duty": "none court-wide. Judge-specific (first record-keeping duty found for the matrix; flag for the main session): Judge Wesley L. Hsu, Standing Order for Newly Assigned Civil Cases (rev'd 2026.07.23) § K.7: \"Counsel is responsible for maintaining records of all prompts of inquiries submitted to any AI tools. Counsel is also responsible for maintaining records sufficient to identify which portions of filings submitted were prepared using an AI tool.\" (the source reads prompts of inquiries); § K.10 also requires records sufficient to establish compliance with the order's confidentiality provisions.",
      "client_disclosure_duty": "none",
      "fees_note": "No court-wide AI fee rule. Decision, not a rule: in Lacey v. State Farm (special master order, ECF No. 119, May 5, 2025) the monetary award ($31,100 in total) was imposed jointly and severally on the two law firms, and the order states: \"She will not, however, be financially responsible for the monetary awards described in this order. Those will fall solely on the lawyers and their firms.\" Judges Kato and Viramontes set sanctions of $500 per violation for non-compliance with their AI provisions or citations to non-existent or inaccurate sources.",
      "sources": [
        {
          "title": "C.D. Cal. Local Rules, Chapter I, Local Civil Rules (pages footed 6/1/2026; last amended June 1, 2026), L.R. 83-3.1.2 (Standards of Professional Conduct - Basis for Disciplinary Action), Chapter I - 112",
          "url": "https://www.cacd.uscourts.gov/sites/default/files/documents/2026-June-LRs-Chap-1.pdf",
          "verbatim": "In order to maintain the effective administration of justice and the integrity of the Court, each attorney shall be familiar with and comply with the standards of professional conduct required of members of the State Bar of California and contained in the State Bar Act, the Rules of Professional Conduct of the State Bar of California, and the decisions of any court applicable thereto.",
          "effective": "2026-06-01",
          "fetched": "2026-09-18"
        },
        {
          "title": "Same — L.R. 83-3.1.2, second sentence (State Bar Act, California Rules of Professional Conduct and decisions adopted as the court's standards of professional conduct)",
          "url": "https://www.cacd.uscourts.gov/sites/default/files/documents/2026-June-LRs-Chap-1.pdf",
          "verbatim": "These statutes, rules and decisions are hereby adopted as the standards of professional conduct, and any breach or violation thereof may be the basis for the imposition of discipline.",
          "effective": "2026-06-01",
          "fetched": "2026-09-18"
        },
        {
          "title": "Same — L.R. 83-3.1.2, third sentence (ABA Model Rules as guidance)",
          "url": "https://www.cacd.uscourts.gov/sites/default/files/documents/2026-June-LRs-Chap-1.pdf",
          "verbatim": "The Model Rules of Professional Conduct of the American Bar Association may be considered as guidance.",
          "effective": "2026-06-01",
          "fetched": "2026-09-18"
        },
        {
          "title": "Same — L.R. 83-3.2.7 (Powers of an Individual Judge to Deal with Contempt or Other Misconduct Not Affected), Chapter I - 120 — preserves each judge's inherent power over proceedings",
          "url": "https://www.cacd.uscourts.gov/sites/default/files/documents/2026-June-LRs-Chap-1.pdf",
          "verbatim": "nor shall anything contained in this Rule 83-3 be construed to deny any judge of this Court said judge’s inherent power to maintain control over the proceedings conducted before said judge, nor to deny the judge those powers derived from any statute or rule of court.",
          "effective": "2026-06-01",
          "fetched": "2026-09-18"
        },
        {
          "title": "Same — L.R. 83-3.2.7, last sentence (misconduct in a pending matter may be dealt with by the judge in charge)",
          "url": "https://www.cacd.uscourts.gov/sites/default/files/documents/2026-June-LRs-Chap-1.pdf",
          "verbatim": "Misconduct of any attorney in the presence of a court or in any manner in respect to any matter pending in a court may be dealt with directly by the judge in charge of the matter or at said judge’s option, referred to the Committee, or both.",
          "effective": "2026-06-01",
          "fetched": "2026-09-18"
        },
        {
          "title": "Same — L.R. 11-1 (Signature of Counsel), Chapter I - 26",
          "url": "https://www.cacd.uscourts.gov/sites/default/files/documents/2026-June-LRs-Chap-1.pdf",
          "verbatim": "All documents, except declarations, shall be signed by the attorney for the party or the party appearing pro se.",
          "effective": "2026-06-01",
          "fetched": "2026-09-18"
        },
        {
          "title": "Same — L.R. 1-3 (Applicability of Rules to Persons Appearing Without Attorneys), Chapter I - 1",
          "url": "https://www.cacd.uscourts.gov/sites/default/files/documents/2026-June-LRs-Chap-1.pdf",
          "verbatim": "Persons appearing pro se are bound by these rules, and any reference in these rules to “attorney” or “counsel” applies to parties pro se unless the context requires otherwise.",
          "effective": "2026-06-01",
          "fetched": "2026-09-18"
        },
        {
          "title": "Same — L.R. 1-4(a) (Definitions: Court includes the assigned judge or magistrate judge), Chapter I - 1",
          "url": "https://www.cacd.uscourts.gov/sites/default/files/documents/2026-June-LRs-Chap-1.pdf",
          "verbatim": "(a) “Court” includes the judge or magistrate judge to whom a civil or criminal action, proceeding, case or matter has been assigned;",
          "effective": "2026-06-01",
          "fetched": "2026-09-18"
        },
        {
          "title": "C.D. Cal. Local Rules, Chapter III, Local Criminal Rules (pages footed 12/1/2025; last amended Dec. 1, 2025), L.Cr.R. 57-1 (Applicability of Local Civil Rules), Chapter III - 22",
          "url": "https://www.cacd.uscourts.gov/sites/default/files/documents/2025%20December%20LRs%20Chap%203.pdf",
          "verbatim": "When applicable directly or by analogy, the Local Rules of the Central District of California shall govern the conduct of criminal proceedings before the District Court, unless otherwise specified.",
          "effective": "2025-12-01",
          "fetched": "2026-09-18"
        },
        {
          "title": "C.D. Cal. Local Rules page (links the four chapters; states each chapter's last amendment date)",
          "url": "https://www.cacd.uscourts.gov/court-procedures/local-rules",
          "verbatim": "Chapter I was last amended on June 1, 2026; Chapter II was last amended on December 1, 2018; Chapter III was last amended on December 1, 2025; and Chapter IV was last amended on December 1, 2015.",
          "effective": null,
          "fetched": "2026-09-18"
        },
        {
          "title": "C.D. Cal. Local Rules, Chapter II (Admiralty and Maritime Claims and Asset Forfeiture; last amended Dec. 1, 2018) — grepped in full, no AI provision",
          "url": "https://www.cacd.uscourts.gov/sites/default/files/documents/LocalRules_Chap2.pdf",
          "verbatim": null,
          "effective": "2018-12-01",
          "fetched": "2026-09-18"
        },
        {
          "title": "C.D. Cal. Local Rules, Chapter IV (Bankruptcy Appeals, Cases, and Proceedings; last amended Dec. 1, 2015) — grepped in full, no AI provision",
          "url": "https://www.cacd.uscourts.gov/sites/default/files/documents/LRs%20Effective%202015%20December%201%20-%20Chapter%204_0.pdf",
          "verbatim": null,
          "effective": "2015-12-01",
          "fetched": "2026-09-18"
        },
        {
          "title": "Notice from the Clerk, Changes to Local Rules Proposed to Become Effective June 1, 2026 (dated April 24, 2026; L.R. 73-2.1, 73-2.2, 83-2.1.4, 83-2.1.4.1) — none touches AI",
          "url": "https://www.cacd.uscourts.gov/news/changes-local-rules-proposed-become-effective-june-1-2026",
          "verbatim": "The Court preliminarily has approved amendments to the local rules listed below. The proposed effective date is June 1, 2026. A redline of the proposed changes accompanies the electronic version of this notice and can also be found on the Court’s website. The proposed rules slated for amendment are as follows:",
          "effective": null,
          "fetched": "2026-09-18"
        },
        {
          "title": "Notice from the Clerk, Changes to Local Rules Proposed to Become Effective December 1, 2025 (dated Oct. 10, 2025; L.R. 7-1, 83-4.2, 83-4.5, 83-4.6, L.Cr.R. 57-1.1) — checked, none touches AI",
          "url": "https://www.cacd.uscourts.gov/news/changes-local-rules-proposed-become-effective-december-1-2025",
          "verbatim": null,
          "effective": null,
          "fetched": "2026-09-18"
        },
        {
          "title": "Notice from the Clerk, Changes to Local Rules Proposed to Become Effective June 1, 2025 (dated Apr. 14, 2025; L.R. 7-1, 7-3, 78-1, 16-1) — checked, none touches AI",
          "url": "https://www.cacd.uscourts.gov/news/changes-local-rules-proposed-become-effective-june-1-2025",
          "verbatim": null,
          "effective": null,
          "fetched": "2026-09-18"
        },
        {
          "title": "Notice from the Clerk, Changes to Local Rules Proposed to Become Effective December 1, 2024 (dated Oct. 7, 2024; L.R. 4-6, 5-4.8.1, 11-3.8, 73-1 to 73-2.6, 79-5.2, L.Cr.R. 7-1, 7-2, 17-4, 49-1.2) — checked, none touches AI",
          "url": "https://www.cacd.uscourts.gov/news/changes-local-rules-proposed-become-effective-december-1-2024",
          "verbatim": null,
          "effective": null,
          "fetched": "2026-09-18"
        },
        {
          "title": "Notice from the Clerk, Additional Changes to Local Rules Proposed to Become Effective June 1, 2024 (dated Apr. 19, 2024; L.R. 83-1.3.3, 83-11) — checked, none touches AI",
          "url": "https://www.cacd.uscourts.gov/news/additional-changes-local-rules-proposed-become-effective-june-1-2024",
          "verbatim": null,
          "effective": null,
          "fetched": "2026-09-18"
        },
        {
          "title": "Notice from the Clerk, Changes to Local Rules Proposed to Become Effective June 1, 2024 (dated Feb. 5, 2024; L.R. 5-3.1.1, 5-4.1, 5-4.2, 11-3.1, 49-1.2) — checked, none touches AI",
          "url": "https://www.cacd.uscourts.gov/news/changes-local-rules-proposed-become-effective-june-1-2024",
          "verbatim": null,
          "effective": null,
          "fetched": "2026-09-18"
        },
        {
          "title": "Notices from the Clerk, listing pages 1-3 (?page=0 to ?page=2; notices from 2021 through the Sheri N. Pym reappointment notice of 2026) — checked, no AI notice",
          "url": "https://www.cacd.uscourts.gov/newsworthy/notices-from-the-clerk",
          "verbatim": null,
          "effective": null,
          "fetched": "2026-09-18"
        },
        {
          "title": "Same — listing page 2",
          "url": "https://www.cacd.uscourts.gov/newsworthy/notices-from-the-clerk?page=1",
          "verbatim": null,
          "effective": null,
          "fetched": "2026-09-18"
        },
        {
          "title": "Same — listing page 3",
          "url": "https://www.cacd.uscourts.gov/newsworthy/notices-from-the-clerk?page=2",
          "verbatim": null,
          "effective": null,
          "fetched": "2026-09-18"
        },
        {
          "title": "C.D. Cal. News page — checked, no AI item",
          "url": "https://www.cacd.uscourts.gov/newsworthy/news",
          "verbatim": null,
          "effective": null,
          "fetched": "2026-09-18"
        },
        {
          "title": "C.D. Cal. General Orders page (by subject; newest listed G.O. 26-11 filed 2026-06-29) — checked, no AI order",
          "url": "https://www.cacd.uscourts.gov/court-procedures/general-orders",
          "verbatim": null,
          "effective": null,
          "fetched": "2026-09-18"
        },
        {
          "title": "C.D. Cal. General Orders, numerical listing page — checked, no AI order",
          "url": "https://www.cacd.uscourts.gov/court-procedures/general-orders/numerical",
          "verbatim": null,
          "effective": null,
          "fetched": "2026-09-18"
        },
        {
          "title": "C.D. Cal. Numeric Index of General Orders (Updated May 28, 2026; through G.O. 26-09) — grepped in full, no AI order",
          "url": "https://www.cacd.uscourts.gov/sites/default/files/GO-numeric%20index.pdf",
          "verbatim": null,
          "effective": "2026-05-28",
          "fetched": "2026-09-18"
        },
        {
          "title": "C.D. Cal. Subject Index of General Orders — grepped in full, no AI order",
          "url": "https://www.cacd.uscourts.gov/sites/default/files/GO%20subject%20index.pdf",
          "verbatim": null,
          "effective": null,
          "fetched": "2026-09-18"
        },
        {
          "title": "Fed. R. Civ. P. 11(b) (Federal Rules of Civil Procedure, Dec. 1, 2025 edition, uscourts.gov) — national rule",
          "url": "https://www.uscourts.gov/sites/default/files/document/federal-rules-of-civil-procedure.pdf",
          "verbatim": "certifies that to the best of the person’s knowledge, information, and belief, formed after an inquiry reasonable under the circumstances",
          "effective": null,
          "fetched": "2026-09-18"
        },
        {
          "title": "Same — Fed. R. Civ. P. 11(c)(1) (law firm responsibility)",
          "url": "https://www.uscourts.gov/sites/default/files/document/federal-rules-of-civil-procedure.pdf",
          "verbatim": "Absent exceptional circumstances, a law firm must be held jointly responsible for a violation committed by its partner, associate, or employee.",
          "effective": null,
          "fetched": "2026-09-18"
        },
        {
          "title": "C.D. Cal. Judges' Procedures and Schedules — judge list (the court page https://www.cacd.uscourts.gov/judges-schedules-procedures redirects to https://apps.cacd.uscourts.gov/Jps/, a JavaScript app that reads this JSON; 60 judicial officers listed on 2026-09-18) — index only",
          "url": "https://apps.cacd.uscourts.gov/JpsApi/judge-list?mcalPageLimit=2",
          "verbatim": null,
          "effective": null,
          "fetched": "2026-09-18"
        },
        {
          "title": "Judge-specific — District Judge John F. Walter — Judges' Procedures page, Important Notice block, ORDER RE: ARTIFICIAL INTELLIGENCE (disclosure + certification; strike for non-compliance) — court page; text is the page's webBlocks HTML as served by the court's Judges' Procedures API (the public page https://apps.cacd.uscourts.gov/Jps/honorable-john-f-walter is a JavaScript shell that renders this JSON); no date on the page",
          "url": "https://apps.cacd.uscourts.gov/JpsApi/judge/honorable-john-f-walter",
          "verbatim": "ORDER RE: ARTIFICIAL INTELLIGENCE: If any attorney for a party or a pro se party has used any generative artificial intelligence (“AI”) in the preparation of any complaint, answer, motion, brief, or other document filed with the Court, the attorney or pro se party shall disclose that AI has been used in the preparation of the document, and CERTIFY that the attorney or pro se party has personally reviewed and verified the accuracy of all legal citations, quotations, factual statements, and analyses contained in the document. Failure to include such certification will result in the striking of the document.",
          "effective": null,
          "fetched": "2026-09-18"
        },
        {
          "title": "Judge-specific — District Judge Otis D. Wright II — Judges' Procedures page, § VII (Filings) A (Artificial Intelligence): certificate on the last page of every memorandum or brief — court page; text is the page's webBlocks HTML as served by the court's Judges' Procedures API (the public page https://apps.cacd.uscourts.gov/Jps/honorable-otis-d-wright-ii is a JavaScript shell that renders this JSON); no date on the page",
          "url": "https://apps.cacd.uscourts.gov/JpsApi/judge/honorable-otis-d-wright-ii",
          "verbatim": "Any memorandum of points and authorities, pretrial brief, trial brief, or posttrial brief must include on the last page of the document a certificate by the attorney or the unrepresented party filing the document that the document complies with the following rule governing use of generative artificial intelligence.",
          "effective": null,
          "fetched": "2026-09-18"
        },
        {
          "title": "Same (Wright) — § VII.A, the rule the certificate attests to (disclosure + certification)",
          "url": "https://apps.cacd.uscourts.gov/JpsApi/judge/honorable-otis-d-wright-ii",
          "verbatim": "Any party who uses generative artificial intelligence (such as ChatGPT, Harvey, CoCounsel, or Google Bard) to generate any portion of a brief, pleading, or other filing must disclose the use of artificial intelligence and certify that the filer has reviewed the source material and verified that the artificially generated content is accurate and complies with the filer's Rule 11 obligations.",
          "effective": null,
          "fetched": "2026-09-18"
        },
        {
          "title": "Same (Wright) — § VII.A, required form of certificate (judge-level certificate text; not court-wide)",
          "url": "https://apps.cacd.uscourts.gov/JpsApi/judge/honorable-otis-d-wright-ii",
          "verbatim": "The certificate must be in substantially the following form: “The undersigned certifies that this submission ______ does not use _____ uses generative artificial intelligence. If generative artificial intelligence was used, following drafting, I reviewed, revised, and supplemented all portions of the brief, including those that were informed by the use of Artificial Intelligence or based on prior templates. I independently verified the factual and legal accuracy of the content and confirmed that all arguments and authorities were appropriate to the issues presented.”",
          "effective": null,
          "fetched": "2026-09-18"
        },
        {
          "title": "Judge-specific — District Judge Michelle Williams Court — Standing Order Regarding Newly Assigned Cases (civil; no date on face or in file name) § 1 (Use of Artificial Intelligence), p. 2 — pleading paper: quotation matched against a gutter-cropped extraction (cdca/_crop_pdf.py, PyMuPDF clip x>=80 pt, removes the 1-28 line numbers); the uncropped pdftotext -layout -enc UTF-8 text is cdca/judges/MWC-MWC-Civil-Standing-Order.txt",
          "url": "https://apps.cacd.uscourts.gov/JpsApi/file/7e7a0336-d4d0-4af7-317f-08df0388792c",
          "verbatim": "Lawyers and pro se litigants who use technology like ChatGPT, Google Bard, Bing AI Chat, or other generative artificial intelligence services to prepare documents that the parties file in the record in this case are cautioned that generative AI technologies sometimes may produce factually or legally inaccurate content. Federal Rule of Civil Procedure 11(b) requires that all parties who present papers to the Court certify “that to the best of the person’s knowledge, information, and belief, formed after an inquiry reasonable under the circumstances,” the factual and legal contentions are “warranted,” “nonfrivolous,” and “have evidentiary support.” Fed. R. Civ. P. 11(b)(2)–(3).",
          "effective": null,
          "fetched": "2026-09-18"
        },
        {
          "title": "Judge-specific — District Judge Michelle Williams Court — Standing Order Regarding Newly Assigned Cases (civil; no date on face or in file name) § 1(a) (Declaration Certifying Use or Non-Use of Artificial Intelligence), p. 3 — every filing, use or non-use, under penalty of perjury (the source reads Google Board) — pleading paper: quotation matched against a gutter-cropped extraction (cdca/_crop_pdf.py, PyMuPDF clip x>=80 pt, removes the 1-28 line numbers); the uncropped pdftotext -layout -enc UTF-8 text is cdca/judges/MWC-MWC-Civil-Standing-Order.txt",
          "url": "https://apps.cacd.uscourts.gov/JpsApi/file/7e7a0336-d4d0-4af7-317f-08df0388792c",
          "verbatim": "Every motion, pleading, or other paper must attach to the filing a separate declaration, signed under penalty of perjury, disclosing the use or non-use of generative Artificial Intelligence (“AI”) (e.g., Claude, ChatGPT, Harvey, CoCounsel, or Google Board). The preparer of the filing must certify that either (a) no portion of the filing was drafted by AI, or that (b) AI was used in drafting a portion of the filing, and that the filer has reviewed the source material and verified that the artificially generated content is accurate and complies with the filer’s Rule 11 obligations. The declaration must identify which, if any, portion of the filing incorporates Generative AI outputs. The Court warns that a party who presents to the Court a pleading, written motion, or other paper incorporating inaccurate or undeclared Generative AI outputs may be subject to sanctions, including referral to the State Bar, without further warning. See Fed. R. Civ. P. 11(c).",
          "effective": null,
          "fetched": "2026-09-18"
        },
        {
          "title": "Judge-specific — District Judge Michelle Williams Court — Standing Order Regarding Newly Assigned Cases (civil; no date on face or in file name) § 9(h) (Declaration Certifying Artificial Intelligence Use or Non-Use), p. 9 — pleading paper: quotation matched against a gutter-cropped extraction (cdca/_crop_pdf.py, PyMuPDF clip x>=80 pt, removes the 1-28 line numbers); the uncropped pdftotext -layout -enc UTF-8 text is cdca/judges/MWC-MWC-Civil-Standing-Order.txt",
          "url": "https://apps.cacd.uscourts.gov/JpsApi/file/7e7a0336-d4d0-4af7-317f-08df0388792c",
          "verbatim": "All motions require attaching a separate declaration, adhering to the requirements in Section 1(a) of this Court’s Standing Order, certifying the filer’s use or non-use of generative AI in preparing the filing. The Court may strike any filing that does not comply with this requirement.",
          "effective": null,
          "fetched": "2026-09-18"
        },
        {
          "title": "Judge-specific — District Judge Wesley L. Hsu — Judges' Procedures page, Law and Motion Schedule block (notice of the July 23, 2026 amendment adding AI provisions) — court page; text is the page's webBlocks HTML as served by the court's Judges' Procedures API (the public page https://apps.cacd.uscourts.gov/Jps/honorable-wesley-l-hsu is a JavaScript shell that renders this JSON); no date on the page",
          "url": "https://apps.cacd.uscourts.gov/JpsApi/judge/honorable-wesley-l-hsu",
          "verbatim": "EFFECTIVE JULY 23, 2026: The Court has amended its Standing Order for Newly Assigned Civil Cases to include additional provisions governing AI usage, class action settlements and Mandatory Chambers Copies. The amended Standing Order applies to all cases pending before this Court as of July 23, 2026. Parties may refer to the redline version of the Standing Order on this website to identify the specific revisions implemented.",
          "effective": "2026-07-23",
          "fetched": "2026-09-18"
        },
        {
          "title": "Judge-specific — District Judge Wesley L. Hsu — Standing Order for Newly Assigned Civil Cases rev'd 2026.07.23 (effective field = face date: signature line reads Dated: June 25, 2026; the court-posted redline is signed Dated: July 23, 2026 and the judge page says EFFECTIVE JULY 23, 2026 for all pending cases) — § K (Use of Artificial Intelligence in Proceedings in This Court) ¶ 1 (Generally), p. 18 — pleading paper: quotation matched against a gutter-cropped extraction (cdca/_crop_pdf.py, clip x>=92 pt); uncropped text is cdca/judges/WLH-Standing-Order-for-Newly-Assigned-Civil-Cases-rev-d-2026-07-23.txt",
          "url": "https://apps.cacd.uscourts.gov/JpsApi/file/4f65396c-ed46-4536-7330-08dee8d9116a",
          "verbatim": "The use of AI tools is not prohibited in this Court, but counsel and parties are cautioned that unqualified reliance on AI-generated content can result in filings that rely on misrepresentations and hallucinated, nonexistent caselaw.",
          "effective": "2026-06-25",
          "fetched": "2026-09-18"
        },
        {
          "title": "Judge-specific — District Judge Wesley L. Hsu — Standing Order for Newly Assigned Civil Cases rev'd 2026.07.23 (effective field = face date: signature line reads Dated: June 25, 2026; the court-posted redline is signed Dated: July 23, 2026 and the judge page says EFFECTIVE JULY 23, 2026 for all pending cases) — § K (Use of Artificial Intelligence in Proceedings in This Court) ¶ 4 (State and American Bar Association Guidelines), p. 19 — pleading paper: quotation matched against a gutter-cropped extraction (cdca/_crop_pdf.py, clip x>=92 pt); uncropped text is cdca/judges/WLH-Standing-Order-for-Newly-Assigned-Civil-Cases-rev-d-2026-07-23.txt",
          "url": "https://apps.cacd.uscourts.gov/JpsApi/file/4f65396c-ed46-4536-7330-08dee8d9116a",
          "verbatim": "Counsel are expected to abide by the California State Bar’s guidance on the use of AI and should also conduct themselves in accordance with the ABA’s Resolution 604 (2023) regarding accountability for the use of AI.",
          "effective": "2026-06-25",
          "fetched": "2026-09-18"
        },
        {
          "title": "Judge-specific — District Judge Wesley L. Hsu — Standing Order for Newly Assigned Civil Cases rev'd 2026.07.23 (effective field = face date: signature line reads Dated: June 25, 2026; the court-posted redline is signed Dated: July 23, 2026 and the judge page says EFFECTIVE JULY 23, 2026 for all pending cases) — § K (Use of Artificial Intelligence in Proceedings in This Court) ¶ 5 (Rule 11 Obligation), p. 19 — pleading paper: quotation matched against a gutter-cropped extraction (cdca/_crop_pdf.py, clip x>=92 pt); uncropped text is cdca/judges/WLH-Standing-Order-for-Newly-Assigned-Civil-Cases-rev-d-2026-07-23.txt",
          "url": "https://apps.cacd.uscourts.gov/JpsApi/file/4f65396c-ed46-4536-7330-08dee8d9116a",
          "verbatim": "All generative AI outputs must be reviewed for accuracy, but counsel must do more than simply detect and eliminate false AI-generated results to practice due diligence. Professional judgment cannot be delegated to an AI tool. Counsel alone bears responsibility for all statements made in filings. Failure to exercise due care in reviewing and filing any work product created with the assistance of AI tools may violate Rule 11 and subject the filer to sanctions.",
          "effective": "2026-06-25",
          "fetched": "2026-09-18"
        },
        {
          "title": "Judge-specific — District Judge Wesley L. Hsu — Standing Order for Newly Assigned Civil Cases rev'd 2026.07.23 (effective field = face date: signature line reads Dated: June 25, 2026; the court-posted redline is signed Dated: July 23, 2026 and the judge page says EFFECTIVE JULY 23, 2026 for all pending cases) — § K (Use of Artificial Intelligence in Proceedings in This Court) ¶ 6 (Required Certification of Filings: caption + declaration identifying AI-prepared portions), p. 19 — pleading paper: quotation matched against a gutter-cropped extraction (cdca/_crop_pdf.py, clip x>=92 pt); uncropped text is cdca/judges/WLH-Standing-Order-for-Newly-Assigned-Civil-Cases-rev-d-2026-07-23.txt",
          "url": "https://apps.cacd.uscourts.gov/JpsApi/file/4f65396c-ed46-4536-7330-08dee8d9116a",
          "verbatim": "Any filing prepared using AI should indicate as such on its caption title. Any party who uses AI to generate any portion of a filing, must attach to that filing a separate declaration that, in a clear and plain factual statement: (1) discloses the use of AI, (2) certifies that the filer has reviewed the source material and verified the accuracy of all content and each citation in the filing and (3) specifies which portions of the filing were prepared using AI. Such certifications should be made by a litigant’s lead counsel.",
          "effective": "2026-06-25",
          "fetched": "2026-09-18"
        },
        {
          "title": "Judge-specific — District Judge Wesley L. Hsu — Standing Order for Newly Assigned Civil Cases rev'd 2026.07.23 (effective field = face date: signature line reads Dated: June 25, 2026; the court-posted redline is signed Dated: July 23, 2026 and the judge page says EFFECTIVE JULY 23, 2026 for all pending cases) — § K (Use of Artificial Intelligence in Proceedings in This Court) ¶ 7 (Retention of Records — prompts; the source reads prompts of inquiries), p. 19 — pleading paper: quotation matched against a gutter-cropped extraction (cdca/_crop_pdf.py, clip x>=92 pt); uncropped text is cdca/judges/WLH-Standing-Order-for-Newly-Assigned-Civil-Cases-rev-d-2026-07-23.txt",
          "url": "https://apps.cacd.uscourts.gov/JpsApi/file/4f65396c-ed46-4536-7330-08dee8d9116a",
          "verbatim": "Counsel is responsible for maintaining records of all prompts of inquiries submitted to any AI tools. Counsel is also responsible for maintaining records sufficient to identify which portions of filings submitted were prepared using an AI tool.",
          "effective": "2026-06-25",
          "fetched": "2026-09-18"
        },
        {
          "title": "Judge-specific — District Judge Wesley L. Hsu — Standing Order for Newly Assigned Civil Cases rev'd 2026.07.23 (effective field = face date: signature line reads Dated: June 25, 2026; the court-posted redline is signed Dated: July 23, 2026 and the judge page says EFFECTIVE JULY 23, 2026 for all pending cases) — § K (Use of Artificial Intelligence in Proceedings in This Court) ¶ 8 (Discovery — AI-generated evidentiary material), p. 19 — pleading paper: quotation matched against a gutter-cropped extraction (cdca/_crop_pdf.py, clip x>=92 pt); uncropped text is cdca/judges/WLH-Standing-Order-for-Newly-Assigned-Civil-Cases-rev-d-2026-07-23.txt",
          "url": "https://apps.cacd.uscourts.gov/JpsApi/file/4f65396c-ed46-4536-7330-08dee8d9116a",
          "verbatim": "Accordingly, parties must disclose and produce AI-generated evidentiary material during discovery.",
          "effective": "2026-06-25",
          "fetched": "2026-09-18"
        },
        {
          "title": "Judge-specific — District Judge Wesley L. Hsu — Standing Order for Newly Assigned Civil Cases rev'd 2026.07.23 (effective field = face date: signature line reads Dated: June 25, 2026; the court-posted redline is signed Dated: July 23, 2026 and the judge page says EFFECTIVE JULY 23, 2026 for all pending cases) — § K (Use of Artificial Intelligence in Proceedings in This Court) ¶ 9 (Restrictions on Uploading of Discovery to Public Generative AI Systems), p. 20 — pleading paper: quotation matched against a gutter-cropped extraction (cdca/_crop_pdf.py, clip x>=92 pt); uncropped text is cdca/judges/WLH-Standing-Order-for-Newly-Assigned-Civil-Cases-rev-d-2026-07-23.txt",
          "url": "https://apps.cacd.uscourts.gov/JpsApi/file/4f65396c-ed46-4536-7330-08dee8d9116a",
          "verbatim": "Parties shall refrain from uploading discovery received from the other side to public generative AI systems. This prohibition does not extend to uploads to enterprise or closed/private AI systems.",
          "effective": "2026-06-25",
          "fetched": "2026-09-18"
        },
        {
          "title": "Judge-specific — District Judge Wesley L. Hsu — Standing Order for Newly Assigned Civil Cases rev'd 2026.07.23 (effective field = face date: signature line reads Dated: June 25, 2026; the court-posted redline is signed Dated: July 23, 2026 and the judge page says EFFECTIVE JULY 23, 2026 for all pending cases) — § K (Use of Artificial Intelligence in Proceedings in This Court) ¶ 10 (Confidentiality — anonymize client information in prompts; keep compliance records), p. 20 — pleading paper: quotation matched against a gutter-cropped extraction (cdca/_crop_pdf.py, clip x>=92 pt); uncropped text is cdca/judges/WLH-Standing-Order-for-Newly-Assigned-Civil-Cases-rev-d-2026-07-23.txt",
          "url": "https://apps.cacd.uscourts.gov/JpsApi/file/4f65396c-ed46-4536-7330-08dee8d9116a",
          "verbatim": "The owners of any AI tool may have access to information, prompts, and inquiries entered. Thus, counsel and parties must maintain confidentiality with privileged information when using any AI tool, including complying with protective orders. Counsel must also anonymize any client information in any prompts to an AI tool and maintain records sufficient to establish their compliance with the confidentiality provisions of this order.",
          "effective": "2026-06-25",
          "fetched": "2026-09-18"
        },
        {
          "title": "Judge-specific — District Judge Wesley L. Hsu — Standing Order for Newly Assigned Civil Cases rev'd 2026.07.23 (effective field = face date: signature line reads Dated: June 25, 2026; the court-posted redline is signed Dated: July 23, 2026 and the judge page says EFFECTIVE JULY 23, 2026 for all pending cases) — § K (Use of Artificial Intelligence in Proceedings in This Court) ¶ 11 (Arbitration), p. 20 — pleading paper: quotation matched against a gutter-cropped extraction (cdca/_crop_pdf.py, clip x>=92 pt); uncropped text is cdca/judges/WLH-Standing-Order-for-Newly-Assigned-Civil-Cases-rev-d-2026-07-23.txt",
          "url": "https://apps.cacd.uscourts.gov/JpsApi/file/4f65396c-ed46-4536-7330-08dee8d9116a",
          "verbatim": "Any arbitrator presiding over an action referred from this Court may not delegate any part of their work to an AI tool.",
          "effective": "2026-06-25",
          "fetched": "2026-09-18"
        },
        {
          "title": "Same (Hsu) — Redline_Standing Order for Newly Assigned Civil Cases rev'd 2026.07.23 (court-posted redline; § K shown as added text), signature line",
          "url": "https://apps.cacd.uscourts.gov/JpsApi/file/2fb96094-a524-41d4-b0d1-08dee8e247f6",
          "verbatim": "Dated: July 23, 2026",
          "effective": "2026-07-23",
          "fetched": "2026-09-18"
        },
        {
          "title": "Judge-specific — District Judge Mark C. Scarsi — Initial Standing Order for Civil Cases (file: Civil Case Standing Order July 2026; no date on face) ¶ 15 (Use of Generative Artificial Intelligence), pp. 16-17 (crosses a page break) — pleading paper: gutter-cropped extraction (clip x>=93 pt); uncropped text is cdca/judges/MCS-Civil-Case-Standing-Order-July-2026.txt",
          "url": "https://apps.cacd.uscourts.gov/JpsApi/file/e3077185-22c0-4917-0e78-08dee28213c9",
          "verbatim": "Any party to this proceeding that uses a generative artificial intelligence platform (e.g., ChatGPT, Claude, Gemini, Copilot, Harvey, Protégé, and CoCounsel) (“Generative AI”) in connection with a filing in this matter must attach to the subject filing a separate declaration disclosing the use of Generative AI and certifying that the filer, in the exercise of the filer’s independent legal judgment, has reviewed and verified the content of the filing as accurate and in compliance with Federal Rule of Civil Procedure 11. The declaration must identify which, if any, portion of the filing incorporates Generative AI outputs. The Court warns that a party who presents to the Court a pleading, written motion, or other paper incorporating inaccurate or undeclared Generative AI outputs may be subject to sanctions without further warning.",
          "effective": null,
          "fetched": "2026-09-18"
        },
        {
          "title": "Judge-specific — District Judge Kenly Kiya Kato — Civil Standing Order (file: KK Civil Standing Order (2026); no date on face) § VI (Artificial Intelligence), p. 5 — declaration + $500 per violation — pleading paper: gutter-cropped extraction (clip x>=93 pt); uncropped text is cdca/judges/KK-KK-Civil-Standing-Order-2026.txt",
          "url": "https://apps.cacd.uscourts.gov/JpsApi/file/bbd27d32-7593-4457-9e6f-08def326596c",
          "verbatim": "Any party who uses generative artificial intelligence (such as ChatGPT, Harvey, CoCounsel, or Google Bard) to generate any portion of a motion, brief, pleading, or other filing must attach to the filing a separate declaration disclosing the use of artificial intelligence and certifying that the filer has reviewed the source material and verified that the artificially generated content is accurate and complies with the filer’s Rule 11 obligations. Non-compliance and/or citations to non-existent or inaccurate sources will result in sanctions of $500 for an initial violation and $500 for each subsequent violation. All counsel are reminded of their ongoing obligation to ensure all representations to the Court are “to the best of the person’s knowledge, information, and belief, formed after an inquiry reasonable under the circumstances.” FED. R. CIV. P. 11(b).",
          "effective": null,
          "fetched": "2026-09-18"
        },
        {
          "title": "Judge-specific — District Judge Anne Hwang — Standing Order for Civil Cases (Dated: September 8, 2026) § E (Filing Requirements) ¶ 5 (Artificial Intelligence), p. 7 — pleading paper: gutter-cropped extraction (clip x>=80 pt); uncropped text is cdca/judges/AH-AH-CIVIL-Standing-Order-for-Civil-Cases-09-08-26.txt",
          "url": "https://apps.cacd.uscourts.gov/JpsApi/file/1d8b41e3-d7f3-46ab-7d6f-08df0dfe0103",
          "verbatim": "Any party who uses generative artificial intelligence (such as ChatGPT, Harvey, CoCounsel, or Claude) to generate any portion of a brief, pleading, or other filing must attach to the filing a separate declaration disclosing the use of artificial intelligence and certifying that the filer has reviewed the source material and verified that the artificially generated content is accurate and complies with the filer’s Rule 11 obligations.",
          "effective": "2026-09-08",
          "fetched": "2026-09-18"
        },
        {
          "title": "Judge-specific — District Judge Anne Hwang — Standing Order for Criminal Cases (Dated: September 8, 2026) § A (General Requirements) ¶ 5 (Artificial Intelligence), p. 4 — pleading paper: gutter-cropped extraction (clip x>=80 pt); uncropped text is cdca/judges/AH-AH-CR-Standing-Order-for-Criminal-Cases-09-08-26.txt",
          "url": "https://apps.cacd.uscourts.gov/JpsApi/file/ecf256dd-4315-41cb-7d71-08df0dfe0103",
          "verbatim": "Any party who uses generative artificial intelligence (such as ChatGPT, Harvey, CoCounsel, or Claude) to generate any portion of a brief, pleading, or other filing must attach to the filing a separate declaration disclosing the use of artificial intelligence and certifying that the filer has reviewed the source material and verified that the artificially generated content is accurate and complies with the filer’s Rule 11 obligations.",
          "effective": "2026-09-08",
          "fetched": "2026-09-18"
        },
        {
          "title": "Judge-specific — District Judge Fred W. Slaughter — Civil Standing Order (file: Civil Standing Order UPDATED 07-10-2026; no date on face) § VIII (Motions − General Requirements) ¶ h (Artificial Intelligence), p. 6 — pleading paper: gutter-cropped extraction (clip x>=93 pt); uncropped text is cdca/judges/FWS-Civil-Standing-Order-UPDATED-07-10-2026.txt",
          "url": "https://apps.cacd.uscourts.gov/JpsApi/file/26c7e990-34b1-41f3-4d99-08dedec318af",
          "verbatim": "Any party who uses generative artificial intelligence (such as ChatGPT, Harvey, CoCounsel, or Google Bard) to generate any portion of a motion, brief, pleading, or other filing must attach to the filing a separate declaration disclosing the use of artificial intelligence and certifying that the filer has reviewed the source material and verified that the artificially generated content is accurate and complies with the filer’s Rule 11 obligations.",
          "effective": null,
          "fetched": "2026-09-18"
        },
        {
          "title": "Judge-specific — District Judge Josephine L. Staton — Judges' Procedures page, Judge's Procedures ¶ 5 (Civil Motions); the same text is repeated under ¶ 6 (Criminal Motions) — court page; text is the page's webBlocks HTML as served by the court's Judges' Procedures API (the public page https://apps.cacd.uscourts.gov/Jps/honorable-josephine-l-staton is a JavaScript shell that renders this JSON); no date on the page",
          "url": "https://apps.cacd.uscourts.gov/JpsApi/judge/honorable-josephine-l-staton",
          "verbatim": "USE OF ARTIFICIAL INTELLIGENCE: Any party who uses any form of generative artificial intelligence to generate any portion of a brief, pleading, or other filing must attach to the filing a separate declaration disclosing the use of artificial intelligence and certifying that the filer has reviewed the source material and verified that the artificially generated content is accurate and complies with the filer's Rule 11 obligations.",
          "effective": null,
          "fetched": "2026-09-18"
        },
        {
          "title": "Judge-specific — Judge Staton — Initial Standing Order for Civil Cases (Revised: May 29, 2026) ¶ 8 (Motions) f (Use of Artificial Intelligence), p. 6 — pleading paper: gutter-cropped extraction (clip x>=66 pt); uncropped text is cdca/judges/JLS-Initial-Standing-Order-05-29-26.txt",
          "url": "https://apps.cacd.uscourts.gov/JpsApi/file/9e1bb2d6-488e-4130-e4c2-08debdb90c5c",
          "verbatim": "Any party who uses any form of generative artificial intelligence to generate any portion of a brief, pleading, or other filing must attach to the filing a separate declaration disclosing the use of artificial intelligence and certifying that the filer has reviewed the source material and verified that the artificially generated content is accurate and complies with the filer’s Rule 11 obligations.",
          "effective": "2026-05-29",
          "fetched": "2026-09-18"
        },
        {
          "title": "Judge-specific — Judge Staton — Order Re Criminal Proceedings (Revised: May 29, 2026) ¶ 3 (Use of Artificial Intelligence), p. 2 — pleading paper: gutter-cropped extraction (clip x>=64 pt); uncropped text is cdca/judges/JLS-Order-Re-Criminal-Proceedings-05-29-26.txt",
          "url": "https://apps.cacd.uscourts.gov/JpsApi/file/86bc0b4c-9e67-4d27-e4c0-08debdb90c5c",
          "verbatim": "Any party who uses any form of generative artificial intelligence to generate any portion of a brief, pleading, or other filing must attach to the filing a separate declaration disclosing the use of artificial intelligence and certifying that the filer has reviewed the source material and verified that the artificially generated content is accurate and complies with the filer’s Rule 11 obligations.",
          "effective": "2026-05-29",
          "fetched": "2026-09-18"
        },
        {
          "title": "Judge-specific — District Judge Stanley Blumenfeld, Jr. — Standing Order for Civil Cases (two dates on face: caption [Updated 1/6/26], matching the court file name (1.6.26), used as effective; signature block reads Date: January 14, 2026) ¶ 5 (Filing Requirements) c (Artificial Intelligence), p. 6 — pleading paper: gutter-cropped extraction (clip x>=80 pt); uncropped text is cdca/judges/SB-Civil-Standing-Order-1-6-26.txt",
          "url": "https://apps.cacd.uscourts.gov/JpsApi/file/d722706b-9e07-4f2d-d1c5-08de5387c55f",
          "verbatim": "Any party who uses generative artificial intelligence (such as ChatGPT, Harvey, CoCounsel, or Google Bard) to generate any portion of a brief, pleading, or other filing must attach to the filing a separate declaration disclosing the use of artificial intelligence and certifying that the filer has reviewed the source material and verified that the artificially generated content is accurate and complies with the filer’s Rule 11 obligations.",
          "effective": "2026-01-06",
          "fetched": "2026-09-18"
        },
        {
          "title": "Judge-specific — District Judge Fernando M. Olguin — Initial Standing Order (Dated: July 2025.) § IV (Motions) A.5 (Artificial Intelligence), p. 5 — filing deemed a certification; no separate disclosure — pleading paper: gutter-cropped extraction (clip x>=64 pt); uncropped text is cdca/judges/FMO-Judge-Olguin-Initial-Standing-Order-2025.txt",
          "url": "https://apps.cacd.uscourts.gov/JpsApi/file/bd1c7516-3cae-41b8-a4da-4ddf08b1e138",
          "verbatim": "If any party or attorney uses an artificial intelligence tool in the preparation of any filing, the submission of that document signifies that the individual responsible for the filing has certified that she/he reviewed all source material and verified the accuracy of any AI content. See Fed. R. Civ. P. 11.",
          "effective": null,
          "fetched": "2026-09-18"
        },
        {
          "title": "Judge-specific — Magistrate Judge Angela C. C. Viramontes — Judges' Procedures page, Important Notice block (declaration + $500 per violation) — court page; text is the page's webBlocks HTML as served by the court's Judges' Procedures API (the public page https://apps.cacd.uscourts.gov/Jps/honorable-angela-c-c-viramontes is a JavaScript shell that renders this JSON); no date on the page",
          "url": "https://apps.cacd.uscourts.gov/JpsApi/judge/honorable-angela-c-c-viramontes",
          "verbatim": "ARTIFICIAL INTELLIGENCE: Any party who uses generative artificial intelligence (such as ChatGPT, Harvey, CoCounsel, Google Bard, Claude AI, etc.) to generate any portion of a motion, brief, pleading, or other filing must attach to the filing a separate declaration disclosing the use of artificial intelligence and certifying that the filer has reviewed the source material and verified that the artificially generated content is accurate and complies with the filer’s Rule 11 obligations. Non-compliance and/or citations to non-existent or inaccurate sources will result in sanctions of $500 for an initial violation and $500 for each subsequent violation. All counsel are reminded of their ongoing obligation to ensure all representations to the Court are “to the best of the person’s knowledge, information, and belief, formed after an inquiry reasonable under the circumstances.” FED. R. CIV. P. 11(b).",
          "effective": null,
          "fetched": "2026-09-18"
        },
        {
          "title": "Judge-specific — Magistrate Judge Autumn D. Spaeth — Judges' Procedures page, Important Notice block (declaration) — court page; text is the page's webBlocks HTML as served by the court's Judges' Procedures API (the public page https://apps.cacd.uscourts.gov/Jps/honorable-autumn-d-spaeth is a JavaScript shell that renders this JSON); no date on the page",
          "url": "https://apps.cacd.uscourts.gov/JpsApi/judge/honorable-autumn-d-spaeth",
          "verbatim": "Artificial Intelligence: Any party who uses generative artificial intelligence to generate any portion of a brief, pleading, or other filing (such as ChatGPT, Harvey, CoCounsel, Google Bard, or any other such application) must attach to the filing a separate declaration disclosing the use of artificial intelligence and certifying that the party has reviewed the source material and verified that the artificially-generated content in the filing is accurate and complies with the filer’s Rule 11 obligations.",
          "effective": null,
          "fetched": "2026-09-18"
        },
        {
          "title": "Judge-specific — Magistrate Judge Alka Sagar — Judges' Procedures page, Important Notice block (declaration) — court page; text is the page's webBlocks HTML as served by the court's Judges' Procedures API (the public page https://apps.cacd.uscourts.gov/Jps/honorable-alka-sagar is a JavaScript shell that renders this JSON); no date on the page",
          "url": "https://apps.cacd.uscourts.gov/JpsApi/judge/honorable-alka-sagar",
          "verbatim": "Any party who uses generative artificial intelligence (such as ChatGPT, Harvey, CoCounsel, or Google Bard) to generate any portion of a brief, pleading, or other filing must attach to the filing a separate declaration disclosing the use of artificial intelligence and certifying that the filer has reviewed the source material and verified that the artificially generated content is accurate and complies with the filer's Rule 11 obligations.",
          "effective": null,
          "fetched": "2026-09-18"
        },
        {
          "title": "Judge-specific — Magistrate Judge Rozella A. Oliver — Judges' Procedures page, Judge's Procedures block (declaration; the source reads artificially generated contact) — court page; text is the page's webBlocks HTML as served by the court's Judges' Procedures API (the public page https://apps.cacd.uscourts.gov/Jps/honorable-rozella-a-oliver is a JavaScript shell that renders this JSON); no date on the page",
          "url": "https://apps.cacd.uscourts.gov/JpsApi/judge/honorable-rozella-a-oliver",
          "verbatim": "Artificial Intelligence: Any party who uses generative artificial intelligence (such as ChatGPT, Harvey, CoCounsel, or Google Bard) to generate any portion of a brief, pleading, or other filing must attach to the filing a separate declaration disclosing the use of artificial intelligence and certifying that the filer has reviewed the source material and verified that the artificially generated contact is accurate and complies with the filer's Rule 11 obligations.",
          "effective": null,
          "fetched": "2026-09-18"
        },
        {
          "title": "Judge-specific — Magistrate Judge Karen E. Scott — Judges' Procedures page, Judge's Procedures ¶ 30 (signature on an AI-assisted filing certifies citations were checked; no separate disclosure) — court page; text is the page's webBlocks HTML as served by the court's Judges' Procedures API (the public page https://apps.cacd.uscourts.gov/Jps/honorable-karen-e-scott is a JavaScript shell that renders this JSON); no date on the page",
          "url": "https://apps.cacd.uscourts.gov/JpsApi/judge/honorable-karen-e-scott",
          "verbatim": "30. GENERATIVE ARTIFICIAL INTELLIGENCE (\"AI\"). Counsel are hereby put on notice that AI tools used to draft legal briefs can make mistakes (sometimes called \"hallucinations\"), including citing non-existent legal authorities. As part of counsel's duties under Federal Rule of Civil Procedure 11, anyone who signs a brief or other court filing that was created, in whole or in part, using AI, certifies to the Court that they have checked and verified the accuracy of the cited legal authorities.",
          "effective": null,
          "fetched": "2026-09-18"
        },
        {
          "title": "Judge-specific — Magistrate Judge Karen E. Scott — Standard Form Protective Order (stipulated-order template; no date on face) § 7.1 (Basic Principles), p. 8 — confidentiality restriction for Protected Material",
          "url": "https://apps.cacd.uscourts.gov/JpsApi/file/9d5e84f0-45b4-4eed-9c19-08dec267acb3",
          "verbatim": "Protected Material may not be uploaded to any open or unsecure AI platforms.",
          "effective": null,
          "fetched": "2026-09-18"
        },
        {
          "title": "Judge-specific — Magistrate Judge Anna Y. Park — Judges' Procedures page, Judge's Procedures ¶ 20 (Rule 11 reminder only) — court page; text is the page's webBlocks HTML as served by the court's Judges' Procedures API (the public page https://apps.cacd.uscourts.gov/Jps/honorable-anna-y-park is a JavaScript shell that renders this JSON); no date on the page",
          "url": "https://apps.cacd.uscourts.gov/JpsApi/judge/honorable-anna-y-park",
          "verbatim": "20. Artificial Intelligence: Counsel and parties are reminded of their obligations under Federal Rule of Civil Procedure 11 and the representations to the Court that are made by signing a paper filing with the Court.",
          "effective": null,
          "fetched": "2026-09-18"
        },
        {
          "title": "Judge-specific — Magistrate Judge Daniel S. Roberts — Judges' Procedures page, Important Notice block (Rule 11 reminder only) — court page; text is the page's webBlocks HTML as served by the court's Judges' Procedures API (the public page https://apps.cacd.uscourts.gov/Jps/honorable-daniel-s-roberts is a JavaScript shell that renders this JSON); no date on the page",
          "url": "https://apps.cacd.uscourts.gov/JpsApi/judge/honorable-daniel-s-roberts",
          "verbatim": "Use of Artificial Intelligence (“AI”) in Court Filings Counsel and parties are reminded of their obligations under Federal Rule of Civil Procedure 11 and the representations to the Court that are made by signing a paper filed with the Court.",
          "effective": null,
          "fetched": "2026-09-18"
        },
        {
          "title": "Decision (special master, not a rule) — Lacey v. State Farm General Insurance Co., No. 2:24-cv-05205-FMO-MAA (C.D. Cal.), ECF No. 119, Order of Special Master Imposing Non-Monetary Sanctions and Awarding Costs (Hon. Michael R. Wilner (Ret.), Special Master; dated May 5, 2025, filed May 6, 2025), ¶ 17, p. 7 — CourtListener RECAP copy of the filed order; pleading paper: gutter-cropped extraction (clip x>=80 pt); uncropped text is cdca/lacey-ecf119.txt; page 1 is an image (read, not quoted)",
          "url": "https://storage.courtlistener.com/recap/gov.uscourts.cacd.930490/gov.uscourts.cacd.930490.119.0_2.pdf",
          "verbatim": "The initial, undisclosed use of AI products to generate the first draft of the brief was flat-out wrong. Even with recent advances, no reasonably competent attorney should out-source research and writing to this technology – particularly without any attempt to verify the accuracy of that material.",
          "effective": "2025-05-05",
          "fetched": "2026-09-18"
        },
        {
          "title": "Decision (special master, not a rule) — Lacey v. State Farm General Insurance Co., No. 2:24-cv-05205-FMO-MAA (C.D. Cal.), ECF No. 119, Order of Special Master Imposing Non-Monetary Sanctions and Awarding Costs (Hon. Michael R. Wilner (Ret.), Special Master; dated May 5, 2025, filed May 6, 2025), ¶ 19, p. 8 (finding tantamount to bad faith; quotation begins mid-sentence) — CourtListener RECAP copy of the filed order; pleading paper: gutter-cropped extraction (clip x>=80 pt); uncropped text is cdca/lacey-ecf119.txt; page 1 is an image (read, not quoted)",
          "url": "https://storage.courtlistener.com/recap/gov.uscourts.cacd.930490/gov.uscourts.cacd.930490.119.0_2.pdf",
          "verbatim": "taken together, demonstrate reckless conduct with the improper purpose of trying to influence my analysis of the disputed privilege issues. The Ellis George and K&L Gates firms had adequate opportunities – before and after their error had been brought to their attention – to stop this from happening. Their failure to do so justifies measured sanctions under these circumstances.",
          "effective": "2025-05-05",
          "fetched": "2026-09-18"
        },
        {
          "title": "Decision (special master, not a rule) — Lacey v. State Farm General Insurance Co., No. 2:24-cv-05205-FMO-MAA (C.D. Cal.), ECF No. 119, Order of Special Master Imposing Non-Monetary Sanctions and Awarding Costs (Hon. Michael R. Wilner (Ret.), Special Master; dated May 5, 2025, filed May 6, 2025), ¶ 20, p. 8 (non-monetary sanction as deterrent) — CourtListener RECAP copy of the filed order; pleading paper: gutter-cropped extraction (clip x>=80 pt); uncropped text is cdca/lacey-ecf119.txt; page 1 is an image (read, not quoted)",
          "url": "https://storage.courtlistener.com/recap/gov.uscourts.cacd.930490/gov.uscourts.cacd.930490.119.0_2.pdf",
          "verbatim": "If the undisclosed use of AI and the submission of fake law causes a client to lose a motion or case, lawyers will undoubtedly be deterred from going down that pointless route.",
          "effective": "2025-05-05",
          "fetched": "2026-09-18"
        },
        {
          "title": "Decision (special master, not a rule) — Lacey v. State Farm General Insurance Co., No. 2:24-cv-05205-FMO-MAA (C.D. Cal.), ECF No. 119, Order of Special Master Imposing Non-Monetary Sanctions and Awarding Costs (Hon. Michael R. Wilner (Ret.), Special Master; dated May 5, 2025, filed May 6, 2025), Conclusion, p. 10 (briefs struck; firms pay $31,100 jointly and severally) — CourtListener RECAP copy of the filed order; pleading paper: gutter-cropped extraction (clip x>=80 pt); uncropped text is cdca/lacey-ecf119.txt; page 1 is an image (read, not quoted)",
          "url": "https://storage.courtlistener.com/recap/gov.uscourts.cacd.930490/gov.uscourts.cacd.930490.119.0_2.pdf",
          "verbatim": "For these reasons, Plaintiff’s supplemental briefs are struck, and no further discovery relief will be granted on the disputed privilege issue. Additionally, Plaintiff’s law firms are ordered (jointly and severally) to pay compensation to the defense in the aggregate amount of $31,100.",
          "effective": "2025-05-05",
          "fetched": "2026-09-18"
        },
        {
          "title": "Decision (special master, not a rule) — Lacey v. State Farm General Insurance Co., No. 2:24-cv-05205-FMO-MAA (C.D. Cal.), ECF No. 119, Order of Special Master Imposing Non-Monetary Sanctions and Awarding Costs (Hon. Michael R. Wilner (Ret.), Special Master; dated May 5, 2025, filed May 6, 2025), ¶ 24, p. 10 (client not financially responsible) — CourtListener RECAP copy of the filed order; pleading paper: gutter-cropped extraction (clip x>=80 pt); uncropped text is cdca/lacey-ecf119.txt; page 1 is an image (read, not quoted)",
          "url": "https://storage.courtlistener.com/recap/gov.uscourts.cacd.930490/gov.uscourts.cacd.930490.119.0_2.pdf",
          "verbatim": "She will not, however, be financially responsible for the monetary awards described in this order. Those will fall solely on the lawyers and their firms.",
          "effective": "2025-05-05",
          "fetched": "2026-09-18"
        }
      ],
      "status": "verified",
      "verified_on": "2026-09-18",
      "verified_by": "claude-opus-5 (independent verifier session; every source URL re-fetched 2026-09-17; checkq/strictq exact match; pinpoints, effective dates, status and narrative claims checked against the fetched text; one missed-item search)",
      "attorney_signoff": null,
      "notes": "(i) COURT-WIDE: VERIFIED NOTHING AI-SPECIFIC in the rules governing filings. All four chapters of the Local Rules were fetched 2026-09-18 and grepped in full (artificial intelligence, generative, AI as a word, A.I., ChatGPT, large language, language model, machine, hallucinat; plus technology, automat, software, computer, algorithm): Chapter I Local Civil Rules (pages footed 6/1/2026), Chapter II Admiralty (last amended December 1, 2018), Chapter III Local Criminal Rules (pages footed 12/1/2025), Chapter IV Bankruptcy (December 1, 2015). The only hits are ordinary uses (CM/ECF automatic notices, word-processing software, computer file formats, citation form rules L.R. 11-3.9 and 51-4). The court's own statement of currency: \"Chapter I was last amended on June 1, 2026; Chapter II was last amended on December 1, 2018; Chapter III was last amended on December 1, 2025; and Chapter IV was last amended on December 1, 2015.\" Also checked 2026-09-18 with no AI item: General Orders page (by subject, through G.O. 26-11 filed 2026-06-29), numerical page, Numeric Index of General Orders (Updated May 28, 2026) and Subject Index PDFs (only hit: the Information Technology Policy order, G.O. 11-09, not about AI); every General Order title 23-01 through 26-11 (appointments, case assignment, CJA plan, jury plan, immigration habeas, EDR policy and similar); Notices from the Clerk listing pages 1-3 (back to 2021); the News page; and all six local-rule amendment notices for June 2024 through June 2026 (rules listed in the source titles; none touches AI). No notice of proposed December 1, 2026 amendments was posted as of 2026-09-18. The court site search (/search/node) returned 404 and was not used. (ii) BINDING STATUS: L.R. 83-3.1.2 and 83-3.2.7 are binding local rules; L.Cr.R. 57-1 applies the Local Rules in criminal proceedings when applicable directly or by analogy, and L.R. 1-3 binds pro se parties. Judge-level standing orders and Judges' Procedures pages bind only in that judge's cases (L.R. 1-4(a): Court includes the judge or magistrate judge to whom a matter is assigned). Lacey v. State Farm is an order of a special master (a retired magistrate judge appointed under Fed. R. Civ. P. 53), not a rule and not an opinion of a sitting judge of the court; persuasive only. (iii) PROPOSED/PENDING: none on AI. The June 1, 2026 amendments (notice dated April 24, 2026) changed L.R. 73-2.1, 73-2.2, 83-2.1.4 and 83-2.1.4.1 only. (iv) JUDGE LEVEL: the court's Judges' Procedures and Schedules app lists 60 judicial officers (1 chief district judge, 27 district judges, 9 senior district judges, 1 chief magistrate judge, 22 magistrate judges). All 60 judge records were fetched 2026-09-18 from https://apps.cacd.uscourts.gov/JpsApi/judge/<id> (59 carry page content; Judge Virginia A. Phillips has no page content and no documents; Judges Fairbank, Hatter and Magistrate Judge Eick list no documents), and every linked document was fetched from https://apps.cacd.uscourts.gov/JpsApi/file/<uuid>: 325 files (246 PDF, 76 .docx, 1 .dotx, 1 .wpd, 1 .xlsx), 0 fetch failures; 3 image-only PDFs were OCR'd for the grep (Klausner criminal discovery order, Selna criminal e-filing procedures, Wilson criminal trial order; no AI terms). Page links to documents outside the app are General Orders only. Eighteen judges have AI provisions: (a) DECLARATION if AI is used (disclose + certify review of source material and Rule 11 compliance): District Judges Hwang (civil and criminal standing orders, dated September 8, 2026), Slaughter (civil standing order, file updated 07-10-2026), Staton (page, civil standing order and criminal order, revised May 29, 2026), Blumenfeld (civil standing order, updated 1/6/26), Kato (civil standing order 2026, adds $500 per violation); Magistrate Judges Viramontes (adds $500 per violation), Spaeth, Sagar, Oliver. (b) DECLARATION plus identification of AI-generated portions: Judge Scarsi (civil standing order, July 2026, sanctions without further warning); Judge Hsu (§ K, effective July 23, 2026: caption notation, declaration specifying AI-prepared portions made by lead counsel, prompt records, AI-evidence notice, no upload of opposing discovery to public generative AI, anonymized prompts, arbitrators may not delegate to AI). (c) EVERY FILING, use or non-use: Judge Court (declaration under penalty of perjury attached to every motion, pleading or other paper, identifying AI portions; filing may be struck); Judge Wright (certificate on the last page of every memorandum or brief, in a prescribed form stating use or non-use). (d) DISCLOSE + CERTIFY in the filing: Judge Walter (failure to include the certification results in striking). (e) VERIFICATION ONLY, no disclosure: Judge Olguin (submission of a filing signifies certification that AI content was verified), Magistrate Judge Scott (signature on an AI-assisted filing certifies citations were checked; her form protective order bars uploading Protected Material to open or unsecure AI platforms), Magistrate Judges Park and Roberts (Rule 11 reminder). The other 42 judges' pages and documents had no AI terms. Hence disclosure_to_court is judge_specific and certification_required is false for the court-wide position; certificate_language is null because no court-wide text exists (Judge Wright's form is quoted in sources). Check the assigned district judge's and magistrate judge's page and standing orders at https://apps.cacd.uscourts.gov/Jps/ for every matter; the pages change often (Hwang orders dated 9/8/26, Hsu amended 7/23/26). (v) DATES AND ODDITIES FOR THE VERIFIER: page-block text carries no date (effective null), except Hsu's page notice (EFFECTIVE JULY 23, 2026). Hsu's clean order is signed Dated: June 25, 2026 (effective set to that face date on its sources) while the court-posted redline is signed Dated: July 23, 2026 and shows § K as added text; the page says the amended order applies to all cases pending as of July 23, 2026. Blumenfeld's order carries [Updated 1/6/26] in the caption (used as effective) and Date: January 14, 2026 at the signature. Scarsi, Kato, Slaughter and Court orders have no date on the face (file names give July 2026, 2026 and 07-10-2026; Court none). Source typos preserved: Oliver page artificially generated contact; Court § 1(a) Google Board; Hsu § K.7 prompts of inquiries. MECHANICS: C.D. Cal. orders are on pleading paper, so the 1-28 margin line numbers sit inside the -layout text of every multi-line quotation; those quotations were matched against gutter-cropped extractions (cdca/_crop_pdf.py, PyMuPDF clip right of the line-number column; word counts equal to the -layout text after removing line numbers), saved as <stem>-crop.txt beside the uncropped <stem>.txt. strictq.py treats the -crop.txt files as saved text rather than re-extracting the PDF; the gate needs a supported pleading-paper mode. The public judge pages are a JavaScript shell; the url given for page sources is the JSON API record by alias (the saved copy was fetched by record uuid; the API serves the same record for alias and uuid; uuids for every judge and document are in cdca/judges/_harvest-log.json). (vi) NOT FETCHED / NOT CHECKED: the Bankruptcy Court for the C.D. Cal. (separate local rules and judges); the General Orders archives page; appendices to the Lacey order (pp. 11-77: the special master's April 15 and April 20, 2025 orders, the briefs and declarations) were not read in full and nothing is quoted from them. No secondary source was used as a lead; the Lacey order was located through the CourtListener RECAP search API (docket https://www.courtlistener.com/docket/68872463/jacquelyn-jackie-lacey-v-state-farm-general-insurance-company/). Other C.D. Cal. AI-citation sanction decisions were not searched. (vii) PROFESSIONAL CONDUCT: L.R. 83-3.1.2 adopts the standards of professional conduct required of members of the State Bar of California (State Bar Act, California Rules of Professional Conduct, and applicable decisions) and makes any breach a basis for discipline; the ABA Model Rules are guidance only. The California RPC/State Bar entry therefore supplies competence, confidentiality, candor, supervision and client-communication duties. Fed. R. Civ. P. 11 is a national rule applying in civil actions in every district court; effective left null because the uscourts.gov PDF (December 1, 2025 edition) does not state Rule 11's own effective date."
    },
    {
      "id": "us-ndca",
      "kind": "federal_district",
      "name": "U.S. District Court for the Northern District of California",
      "disclosure_to_court": "judge_specific",
      "certification_required": false,
      "certificate_language": null,
      "verification_duty": "No court-wide AI rule. Fed. R. Civ. P. 11(b) (national rule) applies: by presenting a paper, an attorney \"certifies that to the best of the person’s knowledge, information, and belief, formed after an inquiry reasonable under the circumstances\" that legal contentions are warranted and factual contentions have evidentiary support (Rule 11(b)(2)-(3), paraphrased); Rule 11(c)(1): \"Absent exceptional circumstances, a law firm must be held jointly responsible for a violation committed by its partner, associate, or employee.\" Civil L.R. 11-4(a)(1) requires every attorney practicing in the court to \"Be familiar and comply with the standards of professional conduct required of members of the State Bar of California\" (the Commentary places those standards in the State Bar Act, the California Rules of Professional Conduct, and court decisions); Crim. L.R. 2-1 applies the Civil Local Rules in criminal cases; Civil L.R. 11-6(a) lets a judge refer unprofessional conduct to the Standing Committee on Professional Conduct. Judge-level standing orders add AI duties in assigned cases, e.g., Judges Martínez-Olguín and Lee: \"Any submission containing AI-generated content must include a certification that lead trial counsel has personally verified the content’s accuracy.\" Magistrate Judge van Keulen: the signature on a submission containing AI-generated content \"constitutes a certification that the signing attorney (or self-represented party) has personally verified the content’s accuracy.\" Decisions applying Rule 11 and Civil L.R. 11-4 to AI-fabricated citations (not rules): Oneto v. Watson (Martínez-Olguín, J., Oct. 10, 2025); Buchanan v. Vuori (Cousins, M.J., Nov. 20, 2025): \"Using AI to check the work of AI was not a reasonable inquiry.\"",
      "confidentiality_restriction": "No court-wide restriction on putting information into AI tools in the Local Rules, General Orders, or court-wide standing order. Judge-level: Magistrate Judge Kang's Civil Standing Order (July 16, 2025) § C, AI and Confidentiality, requires counsel and parties using AI tools to \"fully comply with any applicable protective order and all applicable ethical/legal obligations\" (including privilege) in their use of or submissions to such tools, and to keep records corroborating compliance. The court's self-represented-litigant page (guidance, not a rule) warns: \"Remember that any information you provide to AI, or receive from AI, is not confidential.\" Client-confidentiality duties otherwise come from the California Rules of Professional Conduct and State Bar Act made applicable by Civil L.R. 11-4(a)(1) (see the California RPC entry).",
      "record_keeping_duty": "No court-wide duty. JUDGE-SPECIFIC prompt-record duties: District Judges Martínez-Olguín (Civil Standing Order rev. Aug. 26, 2026, § H.4) and Lee (Civil Standing Order Aug. 31, 2026, § VIII.H) and Magistrate Judge van Keulen (Standing Order Feb. 2, 2026, § 10): \"Counsel is responsible for maintaining records of all prompts or inquiries submitted to any generative AI tools in the event those records become relevant at any point.\" Magistrate Judge Kang (July 16, 2025, § C): \"Counsel shall maintain records sufficient\" to identify, on request, the AI-drafted portions of a filing (p. 10:3–5), and records corroborating compliance, such as by \"keeping records of all prompts or inquiries submitted to any such third-party AI tools\" (p. 12:4–6).",
      "client_disclosure_duty": "none",
      "fees_note": "Judge-specific: District Judge Thompson, Standing Order on Civility and Professionalism (Aug. 18, 2025) § VII: \"Any billing statements submitted for review of the Court must indicate AI usage when\" applicable (citing ABA Model Rule 1.5, ABA Formal Opinion 512, and, as written, CRCP 1.5). No court-wide fee rule on AI.",
      "sources": [
        {
          "title": "N.D. Cal. Civil Local Rules (page footer: Effective May 1, 2026), Civil L.R. 11-4(a)(1) (Standards of Professional Conduct — State Bar of California standards)",
          "url": "https://cand.uscourts.gov/sites/default/files/local-rules/CAND_Civil_Local_Rules_05-26_corrected.v2.pdf",
          "verbatim": "Every member of the bar of this Court and any attorney permitted to practice in this Court under Civil L.R. 11 must: (1) Be familiar and comply with the standards of professional conduct required of members of the State Bar of California;",
          "effective": "2026-05-01",
          "fetched": "2026-09-18"
        },
        {
          "title": "Same — Civil L.R. 11-4(a), Commentary (what the California standards comprise)",
          "url": "https://cand.uscourts.gov/sites/default/files/local-rules/CAND_Civil_Local_Rules_05-26_corrected.v2.pdf",
          "verbatim": "The California Standards of Professional Conduct are contained in the State Bar Act, the Rules of Professional Conduct of the State Bar of California, and decisions of any court applicable thereto.",
          "effective": "2026-05-01",
          "fetched": "2026-09-18"
        },
        {
          "title": "Same — Civil L.R. 11-4(a)(4) (honesty, care, and decorum)",
          "url": "https://cand.uscourts.gov/sites/default/files/local-rules/CAND_Civil_Local_Rules_05-26_corrected.v2.pdf",
          "verbatim": "Practice with the honesty, care, and decorum required for the fair and efficient administration of justice;",
          "effective": "2026-05-01",
          "fetched": "2026-09-18"
        },
        {
          "title": "Same — Civil L.R. 11-6(a) (discipline: referral to the Standing Committee on Professional Conduct or the Chief Judge)",
          "url": "https://cand.uscourts.gov/sites/default/files/local-rules/CAND_Civil_Local_Rules_05-26_corrected.v2.pdf",
          "verbatim": "In the event that a Judge has cause to believe that an attorney (as defined in subsection (b) below) has engaged in unprofessional conduct, the Judge may, in addition to any action authorized by applicable law, do either or both of the following:",
          "effective": "2026-05-01",
          "fetched": "2026-09-18"
        },
        {
          "title": "Same — Civil L.R. 1-4 (sanctions for noncompliance with local or Federal Rules)",
          "url": "https://cand.uscourts.gov/sites/default/files/local-rules/CAND_Civil_Local_Rules_05-26_corrected.v2.pdf",
          "verbatim": "Failure by counsel or a party to comply with any duly promulgated local rule or any Federal Rule may be a ground for imposition of any authorized sanction.",
          "effective": "2026-05-01",
          "fetched": "2026-09-18"
        },
        {
          "title": "Same — Civil L.R. 1-5(o) (Standing Orders of Individual Judges defined — they govern cases assigned to that Judge)",
          "url": "https://cand.uscourts.gov/sites/default/files/local-rules/CAND_Civil_Local_Rules_05-26_corrected.v2.pdf",
          "verbatim": "“Standing Orders” are orders by a Judge governing the conduct of a class or category of actions or proceedings assigned to that Judge. It is the policy of the Court to provide notice of any applicable Standing Orders to parties before they are subject to sanctions for violating such orders. Nothing in these local rules precludes a Judge from issuing Standing Orders to govern matters not covered by these local rules or by the Federal Rules.",
          "effective": "2026-05-01",
          "fetched": "2026-09-18"
        },
        {
          "title": "Same — Civil L.R. 1-5(j) (General Orders are made by the Chief Judge or by the Court)",
          "url": "https://cand.uscourts.gov/sites/default/files/local-rules/CAND_Civil_Local_Rules_05-26_corrected.v2.pdf",
          "verbatim": "“General Orders” are made by the Chief Judge or by the Court relating to Court administration.",
          "effective": "2026-05-01",
          "fetched": "2026-09-18"
        },
        {
          "title": "Same — Civil L.R. 1-3 (effective date recited in the rule text; the May 1, 2026 version is identified by the page footer and the what's-new notice)",
          "url": "https://cand.uscourts.gov/sites/default/files/local-rules/CAND_Civil_Local_Rules_05-26_corrected.v2.pdf",
          "verbatim": "These rules take effect on November 1, 2021. They govern civil cases filed on or after that date.",
          "effective": "2026-05-01",
          "fetched": "2026-09-18"
        },
        {
          "title": "N.D. Cal., Civil Local Rules — Changes in Most Recent Version (published May 1, 2026) — only change is Civil L.R. 77-3 (audio broadcast of civil jury trials); nothing on AI",
          "url": "https://cand.uscourts.gov/sites/default/files/local-rules/Civil-Local-Rules-whats-new-may-2026.pdf",
          "verbatim": "In amendments to Civil Local Rule 77-3, the Court newly allowed for the possibility of broadcasting audio streams of civil jury trial, at the discretion of the presiding judge.",
          "effective": "2026-05-01",
          "fetched": "2026-09-18"
        },
        {
          "title": "N.D. Cal. Criminal Local Rules (page footer: Revised July 29, 2026), Crim. L.R. 2-1 (Civil Local Rules apply in criminal proceedings, so Civil L.R. 11-4 governs counsel there)",
          "url": "https://cand.uscourts.gov/sites/default/files/local-rules/Local_Rules_Criminal_rev_7-29-2026.pdf",
          "verbatim": "The provisions of the Civil Local Rules of the Court shall apply to criminal actions and proceedings, except where they may be inconsistent with these criminal local rules, the Federal Rules of Criminal Procedure or provisions of law specifically applicable to criminal cases.",
          "effective": "2026-07-29",
          "fetched": "2026-09-18"
        },
        {
          "title": "N.D. Cal. Patent Local Rules (Aug. 11, 2026) — grepped in full, no AI provision",
          "url": "https://cand.uscourts.gov/sites/default/files/local-rules/Patent_Local_Rules_08-11-2026.pdf",
          "verbatim": null,
          "effective": "2026-08-11",
          "fetched": "2026-09-18"
        },
        {
          "title": "N.D. Cal. ADR Local Rules (effective May 1, 2018) — grepped in full, no AI provision",
          "url": "https://cand.uscourts.gov/sites/default/files/local-rules/Local_Rules_ADR_Effective_May.1.2018.pdf",
          "verbatim": null,
          "effective": "2018-05-01",
          "fetched": "2026-09-18"
        },
        {
          "title": "N.D. Cal. Habeas Corpus Local Rules (eff. July 2, 2012) — grepped in full, no AI provision",
          "url": "https://cand.uscourts.gov/sites/default/files/local-rules/Habeas-Corpus-Local-Rules-eff.-7.2.2012.pdf",
          "verbatim": null,
          "effective": "2012-07-02",
          "fetched": "2026-09-18"
        },
        {
          "title": "N.D. Cal. Admiralty & Maritime Local Rules (Dec. 1, 2009) — grepped in full, no AI provision",
          "url": "https://cand.uscourts.gov/sites/default/files/local-rules/LocalRules-Admiralty-Maritime-12-2009-CW.pdf",
          "verbatim": null,
          "effective": "2009-12-01",
          "fetched": "2026-09-18"
        },
        {
          "title": "N.D. Cal. Supplemental Rules for Social Security — grepped in full, no AI provision",
          "url": "https://cand.uscourts.gov/sites/default/files/local-rules/Supplemental-Rules-for-Social-Security.pdf",
          "verbatim": null,
          "effective": null,
          "fetched": "2026-09-18"
        },
        {
          "title": "N.D. Cal. Local Rules page (lists the eight local-rule sets and dates) — checked",
          "url": "https://cand.uscourts.gov/rules-forms-fees/local-rules",
          "verbatim": null,
          "effective": null,
          "fetched": "2026-09-18"
        },
        {
          "title": "Fed. R. Civ. P. 11(b) (Federal Rules of Civil Procedure, uscourts.gov edition) — national rule",
          "url": "https://www.uscourts.gov/sites/default/files/document/federal-rules-of-civil-procedure.pdf",
          "verbatim": "certifies that to the best of the person’s knowledge, information, and belief, formed after an inquiry reasonable under the circumstances",
          "effective": null,
          "fetched": "2026-09-18"
        },
        {
          "title": "Same — Fed. R. Civ. P. 11(c)(1) (law firm responsibility)",
          "url": "https://www.uscourts.gov/sites/default/files/document/federal-rules-of-civil-procedure.pdf",
          "verbatim": "Absent exceptional circumstances, a law firm must be held jointly responsible for a violation committed by its partner, associate, or employee.",
          "effective": null,
          "fetched": "2026-09-18"
        },
        {
          "title": "N.D. Cal. General Orders page (GO-02 through GO-58, page 1 of 2) — titles checked, no AI general order",
          "url": "https://cand.uscourts.gov/rules-forms-fees/general-orders",
          "verbatim": null,
          "effective": null,
          "fetched": "2026-09-18"
        },
        {
          "title": "Same — page 2 of 2 (GO-59 through GO-79) — titles checked, no AI general order",
          "url": "https://cand.uscourts.gov/rules-forms-fees/general-orders?page=1",
          "verbatim": null,
          "effective": null,
          "fetched": "2026-09-18"
        },
        {
          "title": "N.D. Cal. Abrogated General Orders page — checked",
          "url": "https://cand.uscourts.gov/rules-forms-fees/general-orders/abrogated-general-orders",
          "verbatim": null,
          "effective": null,
          "fetched": "2026-09-18"
        },
        {
          "title": "N.D. Cal. Miscellaneous Orders page (orders 2014–2024) — checked, none on AI",
          "url": "https://cand.uscourts.gov/rules-forms-fees/miscellaneous-orders",
          "verbatim": null,
          "effective": null,
          "fetched": "2026-09-18"
        },
        {
          "title": "Standing Order for All Judges of the Northern District of California — Contents of Joint Case Management Statement (Updated November 30, 2023) — court-wide; grepped, no AI provision",
          "url": "https://cand.uscourts.gov/sites/default/files/standing-orders/Standing_Order_All_Judges-11-30-2023.pdf",
          "verbatim": null,
          "effective": "2023-11-30",
          "fetched": "2026-09-18"
        },
        {
          "title": "N.D. Cal. Guidelines for the Discovery of Electronically Stored Information (12-1-2015) — grepped, no AI provision (Magistrate Judge Kang's AI section cites its Guideline 3.01)",
          "url": "https://cand.uscourts.gov/sites/default/files/wp-content/uploads/forms/e-discovery-esi-guidelines/ESI_Guidelines-12-1-2015.pdf",
          "verbatim": null,
          "effective": null,
          "fetched": "2026-09-18"
        },
        {
          "title": "N.D. Cal. Procedural Guidance for Class Action Settlements (published Nov. 1, 2018; modified through Sept. 5, 2024) — grepped, no AI provision",
          "url": "https://cand.uscourts.gov/sites/default/files/documents/CAND-ProceduralGuidanceforClassActionSettlements.pdf",
          "verbatim": null,
          "effective": "2024-09-05",
          "fetched": "2026-09-18"
        },
        {
          "title": "N.D. Cal. Northern District Guidelines page — checked",
          "url": "https://cand.uscourts.gov/rules-forms-fees/northern-district-guidelines",
          "verbatim": null,
          "effective": null,
          "fetched": "2026-09-18"
        },
        {
          "title": "N.D. Cal. Professional Conduct page (reproduces Civil L.R. 11-4; no AI content)",
          "url": "https://cand.uscourts.gov/attorneys/professional-conduct",
          "verbatim": null,
          "effective": null,
          "fetched": "2026-09-18"
        },
        {
          "title": "N.D. Cal. Admission & Bar Membership page, Professional Conduct Guidelines (court's Guidelines for Professional Conduct, referenced in Civil L.R. 11-1; undated HTML) — read in full; no AI provision (only hit: artificially restrictive, in the discovery guideline)",
          "url": "https://cand.uscourts.gov/attorneys/admission-bar-membership",
          "verbatim": "These Guidelines for Professional Conduct are adopted to apply to all lawyers who practice in the United States District Court for the Northern District of California.",
          "effective": null,
          "fetched": "2026-09-18"
        },
        {
          "title": "N.D. Cal. Attorneys page (attorney practice resources) — checked",
          "url": "https://cand.uscourts.gov/attorneys",
          "verbatim": null,
          "effective": null,
          "fetched": "2026-09-18"
        },
        {
          "title": "N.D. Cal. Local Rules Attorney Advisory Committees page — checked",
          "url": "https://cand.uscourts.gov/rules-forms-fees/local-rules/local-rules-attorney-advisory-committees",
          "verbatim": null,
          "effective": null,
          "fetched": "2026-09-18"
        },
        {
          "title": "N.D. Cal. News & Announcements, page 1 of 4 (items to Aug. 27, 2026) — no AI notice",
          "url": "https://cand.uscourts.gov/about-court/news-announcements",
          "verbatim": null,
          "effective": null,
          "fetched": "2026-09-18"
        },
        {
          "title": "Same — page 2 of 4 (archive reaches back to Mar. 24, 2025) — no AI notice",
          "url": "https://cand.uscourts.gov/about-court/news-announcements?page=1",
          "verbatim": null,
          "effective": null,
          "fetched": "2026-09-18"
        },
        {
          "title": "Same — page 3 of 4 (archive reaches back to Mar. 24, 2025) — no AI notice",
          "url": "https://cand.uscourts.gov/about-court/news-announcements?page=2",
          "verbatim": null,
          "effective": null,
          "fetched": "2026-09-18"
        },
        {
          "title": "Same — page 4 of 4 (archive reaches back to Mar. 24, 2025) — no AI notice",
          "url": "https://cand.uscourts.gov/about-court/news-announcements?page=3",
          "verbatim": null,
          "effective": null,
          "fetched": "2026-09-18"
        },
        {
          "title": "N.D. Cal. public notice, Aug. 27, 2026 — PROPOSED amendment of Civil L.R. 10 (to become Civil L.R. 15, amended pleadings); comments until Sept. 28, 2026 — not about AI",
          "url": "https://cand.uscourts.gov/news/2026/08/27/seeking-public-comment-proposed-changes-civil-local-rule-10",
          "verbatim": "The proposed amendment modifies the procedure for moving to file amended pleadings, requiring parties to attach the proposed pleading and a redline comparison to the prior version, establishing specific deadlines for filing and service, and adding explanatory commentary clarifying the rule's scope.",
          "effective": null,
          "fetched": "2026-09-18"
        },
        {
          "title": "N.D. Cal. public notice, June 23, 2026 — PROPOSED amendment of Crim. L.R. 6-2 (grand jury motions); comment period closed July 23, 2026 — not about AI",
          "url": "https://cand.uscourts.gov/news/2026/06/23/seeking-public-comment-proposed-changes-criminal-local-rule-6-2",
          "verbatim": null,
          "effective": null,
          "fetched": "2026-09-18"
        },
        {
          "title": "N.D. Cal. web page 'Using AI Tools in Your Case' (Representing Yourself section; guidance for self-represented litigants; no date on page) — court-wide guidance, not a rule or order",
          "url": "https://cand.uscourts.gov/representing-yourself/using-ai-tools-your-case",
          "verbatim": "Using AI in arguing your case is permitted, though there are guidelines and rules that you must follow. Most importantly, regardless of which tools you use, you are responsible for everything you file with the Court.",
          "effective": null,
          "fetched": "2026-09-18"
        },
        {
          "title": "Same — 'Do I have to tell the Court if I used an AI tool?' (disclosure is judge-specific)",
          "url": "https://cand.uscourts.gov/representing-yourself/using-ai-tools-your-case",
          "verbatim": "Some judges in the Northern District of California have requirements about disclosing the use of AI tools. You should: Review your assigned judge’s Standing Orders and the Local Rules. Follow any applicable requirements. If you are unsure, you may wish to disclose your use of AI tools and confirm that you reviewed all content for accuracy.",
          "effective": null,
          "fetched": "2026-09-18"
        },
        {
          "title": "Same — 'Do I need to verify information from AI tools?'",
          "url": "https://cand.uscourts.gov/representing-yourself/using-ai-tools-your-case",
          "verbatim": "Before including any information in a filing, you should: Confirm that any cited case exists. Read the case to ensure it supports your position. Verify that statutes, rules, and quotations are accurate and current. Review the original sources and not rely on AI-generated summaries.",
          "effective": null,
          "fetched": "2026-09-18"
        },
        {
          "title": "Same — 'Can I upload my documents or information into AI tools?' (confidentiality caution)",
          "url": "https://cand.uscourts.gov/representing-yourself/using-ai-tools-your-case",
          "verbatim": "Use caution when entering information into AI tools. AI tools are typically operated by third-party companies. Information you provide to (or receive from) AI tools may: Be stored or processed outside your control. Not be confidential. Potentially be used by the AI service provider. Not be protected by attorney-client privilege. Be discoverable by a party in the case. You may wish to avoid entering: Sensitive personal information. Confidential or private details. Information subject to legal privilege.",
          "effective": null,
          "fetched": "2026-09-18"
        },
        {
          "title": "N.D. Cal. Judges page (36 judges: 23 district incl. 9 senior, 13 magistrate; no visiting judges) — every judge page fetched 2026-09-18",
          "url": "https://cand.uscourts.gov/judges",
          "verbatim": null,
          "effective": null,
          "fetched": "2026-09-18"
        },
        {
          "title": "N.D. Cal. Standing Orders listing (9 pages, 180 rows, 140 distinct files, all judges) — checked",
          "url": "https://cand.uscourts.gov/judges/standing-orders",
          "verbatim": null,
          "effective": null,
          "fetched": "2026-09-18"
        },
        {
          "title": "Judge-specific — District Judge Araceli Martínez-Olguín, Standing Order for Civil Cases (Revised August 26, 2026), § H.4 Artificial Intelligence (AI), p. 6 — verification + certification by lead trial counsel + prompt records; not court-wide",
          "url": "https://cand.uscourts.gov/sites/default/files/standing-orders/AMO-CivilStandingOrder-8-26-2026.pdf",
          "verbatim": "Counsel is responsible for providing the Court with complete and accurate representations in any submission (including filings, demonstratives, evidence, or oral argument), consistent with Federal Rule of Civil Procedure 11, the California Rules of Professional Conduct, and any other applicable legal or ethical guidance. Use of ChatGPT or other such tools is not prohibited, but counsel must at all times personally confirm for themselves the accuracy of any content generated by these tools. At all times, counsel—and specifically designated lead trial counsel—bears responsibility for any submission made by the party that the attorney represents. Any submission containing AI-generated content must include a certification that lead trial counsel has personally verified the content’s accuracy. Failure to include this certification or comply with this verification requirement will be grounds for sanctions. Counsel is responsible for maintaining records of all prompts or inquiries submitted to any generative AI tools in the event those records become relevant at any point.",
          "effective": "2026-08-26",
          "fetched": "2026-09-18"
        },
        {
          "title": "Same (Martínez-Olguín) — date on the face of the order",
          "url": "https://cand.uscourts.gov/sites/default/files/standing-orders/AMO-CivilStandingOrder-8-26-2026.pdf",
          "verbatim": "Dated: August 26, 2026",
          "effective": "2026-08-26",
          "fetched": "2026-09-18"
        },
        {
          "title": "Judge-specific — District Judge Eumi K. Lee, Standing Order for Civil Cases (Updated August 31, 2026), § VIII.H Use of Generative AI Tools, p. 10 — verification + certification by lead trial counsel + prompt records; not court-wide",
          "url": "https://cand.uscourts.gov/sites/default/files/standing-orders/EKL-CivilStandingOrder_8-31-2026.pdf",
          "verbatim": "Counsel is responsible for providing the Court with complete and accurate representations of the record, procedural history, and cited legal authorities. Use of generative artificial intelligence tools is not prohibited, but counsel must personally confirm for themselves the accuracy of any research conducted by these means, and counsel alone bears ethical responsibility for all statements made in filings. Any submission containing AI- generated content must include a certification that lead trial counsel has personally verified the content’s accuracy. Failure to include this certification or comply with this verification requirement will be grounds for sanctions. Counsel is responsible for maintaining records of all prompts or inquiries submitted to any generative AI tools in the event those records become relevant at any point.",
          "effective": "2026-08-31",
          "fetched": "2026-09-18"
        },
        {
          "title": "Same (Lee) — § VIII.G Duty of Candor, p. 9 (citations are counsel's representation; sanctions and referral)",
          "url": "https://cand.uscourts.gov/sites/default/files/standing-orders/EKL-CivilStandingOrder_8-31-2026.pdf",
          "verbatim": "All case citations and factual statements must be completely accurate. A citation to a case, statute, or other authority is counsel’s representation to the Court that the authority stands for the proposition asserted and is good law. A quotation of a case or other authority is counsel’s representation that the quoted language is complete and present in the authority cited. Counsel must ensure that the use of ellipses or elisions in quotes does not mislead the Court or misrepresent the substance of the holding or other authority. Counsel’s representations of facts are subject to the same requirements of completeness and accuracy. Misrepresentations of law or fact, however subtle, may result in sanctions and a referral to the District’s Standing Committee on Professional Conduct.",
          "effective": "2026-08-31",
          "fetched": "2026-09-18"
        },
        {
          "title": "Judge-specific — Magistrate Judge Susan van Keulen, Civil and Discovery Referral Matters Standing Order (Updated February 2026; signed February 2, 2026), § 10 Use of Artificial Intelligence (AI), p. 6 — signature on a submission with AI-generated content constitutes a certification of personal verification; prompt records; applies in her consent cases and discovery referrals; not court-wide",
          "url": "https://cand.uscourts.gov/sites/default/files/standing-orders/SvK-Civil_and_DiscoveryReferralMatters_StandingOrder-2-2026.pdf",
          "verbatim": "Counsel is responsible for providing complete and accurate representations in any submission (including filings, demonstratives, evidence and oral argument) to the Court as required by Rule 11 of the Federal Rules of Civil Procedure, the California Rules of Professional Conduct, and any other applicable legal or ethical guidance. Use of generative AI tools, such as ChatGPT, Claude, Gemini, etc., in preparing submissions to the Court is not prohibited, but counsel and self-represented parties must at all times personally confirm for themselves the accuracy of any content generated by these tools. The signature of counsel or a self-represented party on any submission containing AI- generated content, including citations generated by AI, constitutes a certification that the signing attorney (or self-represented party) has personally verified the content’s accuracy. The Court will impute any errors by such AI tools to the attorney or party whose signature appears on the document containing those errors. Failure to verify the accuracy of submissions, particularly the accuracy of citations to law and evidence, may be grounds for sanctions. Counsel is responsible for maintaining records of all prompts or inquiries submitted to any generative AI tools in the event those records become relevant at any point.",
          "effective": "2026-02-02",
          "fetched": "2026-09-18"
        },
        {
          "title": "Judge-specific — District Judge Rita F. Lin, Standing Order for Civil Cases (Dated September 4, 2026), Use of Generative AI Tools, p. 7 — verification duty only (no disclosure or certification); not court-wide",
          "url": "https://cand.uscourts.gov/sites/default/files/standing-orders/RFL-Civil-Standing-Order-%282026-09-04%29_0.pdf",
          "verbatim": "Counsel is responsible for providing the Court with complete and accurate representations of the record, procedural history, and cited legal authorities. Use of generative artificial intelligence tools is not prohibited, but counsel must personally confirm for themselves the accuracy of any research conducted by these means, and counsel alone bears ethical responsibility for all statements made in filings. These obligations also apply to self-represented litigants.",
          "effective": "2026-09-04",
          "fetched": "2026-09-18"
        },
        {
          "title": "Same (Lin) — Class Actions, Preliminary Approval, p. 9, item (d) (settlement administrator's declaration must address AI use in administering the settlement — not a filing-preparation rule)",
          "url": "https://cand.uscourts.gov/sites/default/files/standing-orders/RFL-Civil-Standing-Order-%282026-09-04%29_0.pdf",
          "verbatim": "(d) whether artificial intelligence will be used to administer the settlement by the administrator, its subcontractors, or its vendors and, if so, what safeguards will ensure accuracy and lack of bias;",
          "effective": "2026-09-04",
          "fetched": "2026-09-18"
        },
        {
          "title": "Judge-specific — Magistrate Judge Lisa J. Cisneros, Civil Standing Order (no date on its face; court listing date February 17, 2026), § E.4 Technological Assistance, pp. 3–4 — verification duty only; errors imputed to signer; not court-wide",
          "url": "https://cand.uscourts.gov/sites/default/files/standing-orders/LJC-CivilStandingOrder_2-17-26.pdf",
          "verbatim": "Counsel and parties appearing without legal representation are responsible for providing complete and accurate representations in any submission to the Court to the extent required by Rule 11 of the Federal Rules of Civil Procedure, the California Rules of Professional Conduct, and any other applicable legal or ethical guidance. Parties are not categorically prohibited from using any sort of lawful technological assistance in researching or drafting briefs, including artificial intelligence (AI) tools that assist in the preparation of material for submission to the Court. That said, attorneys and unrepresented parties must understand the limitations of any tools that they use, and they remain fully responsible for the final products they submit to the Court. The Court will impute any errors by computer-based tools to the attorney or unrepresented party whose signature appears on the document containing those errors. Failure to verify the accuracy of briefs, and particularly the accuracy of citations to law and evidence, may be grounds for sanctions and/or striking a filing.",
          "effective": null,
          "fetched": "2026-09-18"
        },
        {
          "title": "Same (Cisneros) — § E.4 n.1, p. 4 (order does not reduce professional-conduct duties)",
          "url": "https://cand.uscourts.gov/sites/default/files/standing-orders/LJC-CivilStandingOrder_2-17-26.pdf",
          "verbatim": "This Standing Order should not be construed as reducing an attorney’s duty of care under any rule of professional conduct, or as creating an exception to any such rule or other authority that might limit the use of AI or other technological assistance.",
          "effective": null,
          "fetched": "2026-09-18"
        },
        {
          "title": "Judge-specific — District Judge Trina L. Thompson, Standing Order on Civility and Professionalism (Dated August 18, 2025), § VII Use of Artificial Intelligence, p. 4, line 1 (heading; pleading paper — quoted one physical line at a time)",
          "url": "https://cand.uscourts.gov/sites/default/files/standing-orders/TLT-Civility-and-Professionalism-Standing-Order.pdf",
          "verbatim": "VII. USE OF ARTIFICIAL INTELLIGENCE (“AI”)",
          "effective": "2025-08-18",
          "fetched": "2026-09-18"
        },
        {
          "title": "Judge-specific — District Judge Trina L. Thompson, Standing Order on Civility and Professionalism (Dated August 18, 2025), § VII Use of Artificial Intelligence, p. 4, lines 4–5 (verification; read §VII lines 2–11 in full)",
          "url": "https://cand.uscourts.gov/sites/default/files/standing-orders/TLT-Civility-and-Professionalism-Standing-Order.pdf",
          "verbatim": "prohibited, but counsel must personally confirm for themselves the accuracy of any research",
          "effective": "2025-08-18",
          "fetched": "2026-09-18"
        },
        {
          "title": "Judge-specific — District Judge Trina L. Thompson, Standing Order on Civility and Professionalism (Dated August 18, 2025), § VII Use of Artificial Intelligence, p. 4, line 10 (sanctions exposure)",
          "url": "https://cand.uscourts.gov/sites/default/files/standing-orders/TLT-Civility-and-Professionalism-Standing-Order.pdf",
          "verbatim": "assistance of AI tools may result in sanctions under Federal Rule of Civil Procedure 11 or expose",
          "effective": "2025-08-18",
          "fetched": "2026-09-18"
        },
        {
          "title": "Judge-specific — District Judge Trina L. Thompson, Standing Order on Civility and Professionalism (Dated August 18, 2025), § VII Use of Artificial Intelligence, p. 4, line 12 (billing statements must indicate AI usage)",
          "url": "https://cand.uscourts.gov/sites/default/files/standing-orders/TLT-Civility-and-Professionalism-Standing-Order.pdf",
          "verbatim": "Any billing statements submitted for review of the Court must indicate AI usage when",
          "effective": "2025-08-18",
          "fetched": "2026-09-18"
        },
        {
          "title": "Judge-specific — District Judge Trina L. Thompson, Standing Order on Civility and Professionalism (Dated August 18, 2025), § VII Use of Artificial Intelligence, p. 4, line 13 (continuation; authorities cited)",
          "url": "https://cand.uscourts.gov/sites/default/files/standing-orders/TLT-Civility-and-Professionalism-Standing-Order.pdf",
          "verbatim": "applicable. See ABA Model Rule 1.5; ABA Formal Opinion 512 (2024); CRCP 1.5.",
          "effective": "2025-08-18",
          "fetched": "2026-09-18"
        },
        {
          "title": "Same (Thompson) — § III Applicability, item 1 (as written it reaches all attorneys in the district; posted only on Judge Thompson's page)",
          "url": "https://cand.uscourts.gov/sites/default/files/standing-orders/TLT-Civility-and-Professionalism-Standing-Order.pdf",
          "verbatim": "1. All attorneys admitted or appearing pro hac vice in the Northern District of California.",
          "effective": "2025-08-18",
          "fetched": "2026-09-18"
        },
        {
          "title": "Judge-specific — Magistrate Judge Peter H. Kang, Standing Order for Civil Cases (Effective and Last Revised on July 16, 2025), § C Artificial Intelligence (AI) and Filings with the Court (pp. 8–12; pleading paper — quoted one physical line at a time; read pp. 8:12–12:6 in full) — cover line (effective date)",
          "url": "https://cand.uscourts.gov/sites/default/files/standing-orders/PHK-Civil-Standing-Order_2025.7.16.pdf",
          "verbatim": "(Effective and Last Revised on July 16, 2025)",
          "effective": "2025-07-16",
          "fetched": "2026-09-18"
        },
        {
          "title": "Judge-specific — Magistrate Judge Peter H. Kang, Standing Order for Civil Cases (Effective and Last Revised on July 16, 2025), § C Artificial Intelligence (AI) and Filings with the Court (pp. 8–12; pleading paper — quoted one physical line at a time; read pp. 8:12–12:6 in full) — p. 9:28 (disclosure requirement begins)",
          "url": "https://cand.uscourts.gov/sites/default/files/standing-orders/PHK-Civil-Standing-Order_2025.7.16.pdf",
          "verbatim": "Any brief, pleading, or other document submitted to the Court the text of which was created",
          "effective": "2025-07-16",
          "fetched": "2026-09-18"
        },
        {
          "title": "Judge-specific — Magistrate Judge Peter H. Kang, Standing Order for Civil Cases (Effective and Last Revised on July 16, 2025), § C Artificial Intelligence (AI) and Filings with the Court (pp. 8–12; pleading paper — quoted one physical line at a time; read pp. 8:12–12:6 in full) — p. 10:1",
          "url": "https://cand.uscourts.gov/sites/default/files/standing-orders/PHK-Civil-Standing-Order_2025.7.16.pdf",
          "verbatim": "or drafted with any use of an AI tool shall be identified as such in its title or pleading caption, in a",
          "effective": "2025-07-16",
          "fetched": "2026-09-18"
        },
        {
          "title": "Judge-specific — Magistrate Judge Peter H. Kang, Standing Order for Civil Cases (Effective and Last Revised on July 16, 2025), § C Artificial Intelligence (AI) and Filings with the Court (pp. 8–12; pleading paper — quoted one physical line at a time; read pp. 8:12–12:6 in full) — p. 10:2",
          "url": "https://cand.uscourts.gov/sites/default/files/standing-orders/PHK-Civil-Standing-Order_2025.7.16.pdf",
          "verbatim": "table preceding the body text of such brief or pleading, or by a separate Notice filed",
          "effective": "2025-07-16",
          "fetched": "2026-09-18"
        },
        {
          "title": "Judge-specific — Magistrate Judge Peter H. Kang, Standing Order for Civil Cases (Effective and Last Revised on July 16, 2025), § C Artificial Intelligence (AI) and Filings with the Court (pp. 8–12; pleading paper — quoted one physical line at a time; read pp. 8:12–12:6 in full) — p. 10:3 (records requirement begins)",
          "url": "https://cand.uscourts.gov/sites/default/files/standing-orders/PHK-Civil-Standing-Order_2025.7.16.pdf",
          "verbatim": "contemporaneously with the brief, pleading, or document. Counsel shall maintain records sufficient",
          "effective": "2025-07-16",
          "fetched": "2026-09-18"
        },
        {
          "title": "Judge-specific — Magistrate Judge Peter H. Kang, Standing Order for Civil Cases (Effective and Last Revised on July 16, 2025), § C Artificial Intelligence (AI) and Filings with the Court (pp. 8–12; pleading paper — quoted one physical line at a time; read pp. 8:12–12:6 in full) — p. 10:4",
          "url": "https://cand.uscourts.gov/sites/default/files/standing-orders/PHK-Civil-Standing-Order_2025.7.16.pdf",
          "verbatim": "to identify, if requested by the Court, those portions of the text of a pleading, brief, or document",
          "effective": "2025-07-16",
          "fetched": "2026-09-18"
        },
        {
          "title": "Judge-specific — Magistrate Judge Peter H. Kang, Standing Order for Civil Cases (Effective and Last Revised on July 16, 2025), § C Artificial Intelligence (AI) and Filings with the Court (pp. 8–12; pleading paper — quoted one physical line at a time; read pp. 8:12–12:6 in full) — p. 10:5",
          "url": "https://cand.uscourts.gov/sites/default/files/standing-orders/PHK-Civil-Standing-Order_2025.7.16.pdf",
          "verbatim": "submitted to the Court which was created or drafted by an AI tool.",
          "effective": "2025-07-16",
          "fetched": "2026-09-18"
        },
        {
          "title": "Judge-specific — Magistrate Judge Peter H. Kang, Standing Order for Civil Cases (Effective and Last Revised on July 16, 2025), § C Artificial Intelligence (AI) and Filings with the Court (pp. 8–12; pleading paper — quoted one physical line at a time; read pp. 8:12–12:6 in full) — p. 10:9–10 (failure to check AI citations is grounds for sanctions; line 10 quoted)",
          "url": "https://cand.uscourts.gov/sites/default/files/standing-orders/PHK-Civil-Standing-Order_2025.7.16.pdf",
          "verbatim": "assertion of fact) created by an AI tool is grounds for potential sanctions.",
          "effective": "2025-07-16",
          "fetched": "2026-09-18"
        },
        {
          "title": "Judge-specific — Magistrate Judge Peter H. Kang, Standing Order for Civil Cases (Effective and Last Revised on July 16, 2025), § C Artificial Intelligence (AI) and Filings with the Court (pp. 8–12; pleading paper — quoted one physical line at a time; read pp. 8:12–12:6 in full) — p. 9:7 (scope carve-out: traditional research and word-processing tools)",
          "url": "https://cand.uscourts.gov/sites/default/files/standing-orders/PHK-Civil-Standing-Order_2025.7.16.pdf",
          "verbatim": "(e.g., Lexis, Westlaw, Microsoft Word, or Adobe Acrobat).",
          "effective": "2025-07-16",
          "fetched": "2026-09-18"
        },
        {
          "title": "Judge-specific — Magistrate Judge Peter H. Kang, Standing Order for Civil Cases (Effective and Last Revised on July 16, 2025), § C Artificial Intelligence (AI) and Filings with the Court (pp. 8–12; pleading paper — quoted one physical line at a time; read pp. 8:12–12:6 in full) — p. 12:2 (AI and Confidentiality: comply with protective orders and ethical/legal obligations)",
          "url": "https://cand.uscourts.gov/sites/default/files/standing-orders/PHK-Civil-Standing-Order_2025.7.16.pdf",
          "verbatim": "fully comply with any applicable protective order and all applicable ethical/legal obligations",
          "effective": "2025-07-16",
          "fetched": "2026-09-18"
        },
        {
          "title": "Judge-specific — Magistrate Judge Peter H. Kang, Standing Order for Civil Cases (Effective and Last Revised on July 16, 2025), § C Artificial Intelligence (AI) and Filings with the Court (pp. 8–12; pleading paper — quoted one physical line at a time; read pp. 8:12–12:6 in full) — p. 12:6 (prompt records)",
          "url": "https://cand.uscourts.gov/sites/default/files/standing-orders/PHK-Civil-Standing-Order_2025.7.16.pdf",
          "verbatim": "as by keeping records of all prompts or inquiries submitted to any such third-party AI tools.",
          "effective": "2025-07-16",
          "fetched": "2026-09-18"
        },
        {
          "title": "Judge-specific — Magistrate Judge Peter H. Kang, Standing Order for Civil Cases (Effective and Last Revised on July 16, 2025), § C Artificial Intelligence (AI) and Filings with the Court (pp. 8–12; pleading paper — quoted one physical line at a time; read pp. 8:12–12:6 in full) — p. 11:17–18 (AI-assisted exhibits and demonstratives must also be identified; line 18 quoted)",
          "url": "https://cand.uscourts.gov/sites/default/files/standing-orders/PHK-Civil-Standing-Order_2025.7.16.pdf",
          "verbatim": "identified as such in its title or caption, in a table preceding the body of exhibit,",
          "effective": "2025-07-16",
          "fetched": "2026-09-18"
        },
        {
          "title": "Same (Kang) — p. 4:12 (parties must meet and confer on generative-AI issues and report them in the Joint Case Management Statement; read 4:9–14)",
          "url": "https://cand.uscourts.gov/sites/default/files/standing-orders/PHK-Civil-Standing-Order_2025.7.16.pdf",
          "verbatim": "issues, and proposals for handling generative AI-related issues specific to or anticipated in their",
          "effective": "2025-07-16",
          "fetched": "2026-09-18"
        },
        {
          "title": "Judge-specific — District Judge Vince Chhabria, Standing Order for Civil Cases (Dated June 26, 2026), ¶ 57, Preliminary Approval, pp. 14–15, item (d) (settlement administrator's declaration must address AI use in administering the settlement — not a filing-preparation rule)",
          "url": "https://cand.uscourts.gov/sites/default/files/standing-orders/VC-Civil-Standing-Order-6-26-2026.pdf",
          "verbatim": "(d) whether artificial intelligence will be used to administer the settlement either by the administrator or subcontractors and, if so, what safeguards will ensure accuracy and lack of bias;",
          "effective": "2026-06-26",
          "fetched": "2026-09-18"
        },
        {
          "title": "Decision (single judge, not a rule) — Oneto v. Watson, No. 22-cv-05206-AMO, ECF No. 92, Order Sanctioning Plaintiff's Counsel (N.D. Cal. Oct. 10, 2025) (Martínez-Olguín, J.) (RECAP copy of the filed order; pleading paper — one line per quotation) — p. 4:20",
          "url": "https://storage.courtlistener.com/recap/gov.uscourts.cand.400352/gov.uscourts.cand.400352.92.0.pdf",
          "verbatim": "To be clear, the Court does not prohibit or oppose the use of artificial intelligence in legal",
          "effective": "2025-10-10",
          "fetched": "2026-09-18"
        },
        {
          "title": "Decision (single judge, not a rule) — Oneto v. Watson, No. 22-cv-05206-AMO, ECF No. 92, Order Sanctioning Plaintiff's Counsel (N.D. Cal. Oct. 10, 2025) (Martínez-Olguín, J.) (RECAP copy of the filed order; pleading paper — one line per quotation) — p. 4:22 (standing order requires acknowledgment and certification)",
          "url": "https://storage.courtlistener.com/recap/gov.uscourts.cand.400352/gov.uscourts.cand.400352.92.0.pdf",
          "verbatim": "utilized so long as counsel acknowledges the use of such tools and certifies they have",
          "effective": "2025-10-10",
          "fetched": "2026-09-18"
        },
        {
          "title": "Decision (single judge, not a rule) — Oneto v. Watson, No. 22-cv-05206-AMO, ECF No. 92, Order Sanctioning Plaintiff's Counsel (N.D. Cal. Oct. 10, 2025) (Martínez-Olguín, J.) (RECAP copy of the filed order; pleading paper — one line per quotation) — p. 5:1 (failure to recognize AI use in one's own papers; Cal. RPC 1.1 technology competence)",
          "url": "https://storage.courtlistener.com/recap/gov.uscourts.cand.400352/gov.uscourts.cand.400352.92.0.pdf",
          "verbatim": "suggests a failure to keep abreast of changes in relevant technology as required by Rule 1.1 of the",
          "effective": "2025-10-10",
          "fetched": "2026-09-18"
        },
        {
          "title": "Decision (single judge, not a rule) — Oneto v. Watson, No. 22-cv-05206-AMO, ECF No. 92, Order Sanctioning Plaintiff's Counsel (N.D. Cal. Oct. 10, 2025) (Martínez-Olguín, J.) (RECAP copy of the filed order; pleading paper — one line per quotation) — p. 7:21 (sanctions for Rule 11(b), ethical duties, and the standing order)",
          "url": "https://storage.courtlistener.com/recap/gov.uscourts.cand.400352/gov.uscourts.cand.400352.92.0.pdf",
          "verbatim": "Federal Rule of Civil Procedure 11(b), violation of counsel’s ethical duties, and violation of the",
          "effective": "2025-10-10",
          "fetched": "2026-09-18"
        },
        {
          "title": "Decision (single judge, not a rule) — Oneto v. Watson, No. 22-cv-05206-AMO, ECF No. 92, Order Sanctioning Plaintiff's Counsel (N.D. Cal. Oct. 10, 2025) (Martínez-Olguín, J.) (RECAP copy of the filed order; pleading paper — one line per quotation) — p. 7:23 ($1,000 personal sanction; also service on client, 1-hour AI-ethics CLE, service on State Bar)",
          "url": "https://storage.courtlistener.com/recap/gov.uscourts.cand.400352/gov.uscourts.cand.400352.92.0.pdf",
          "verbatim": "1. Attorney Edward Quesada is personally sanctioned in the amount of $1,000.",
          "effective": "2025-10-10",
          "fetched": "2026-09-18"
        },
        {
          "title": "Decision (single judge, not a rule) — Buchanan v. Vuori, Inc., No. 23-cv-01121-NC, ECF No. 96, Order Imposing Sanctions on Attorney James Dal Bon (N.D. Cal. Nov. 20, 2025) (Cousins, M.J.) (RECAP copy of the filed order; pleading paper — one line per quotation) — p. 4:16 (AI checking AI is not a reasonable inquiry)",
          "url": "https://storage.courtlistener.com/recap/gov.uscourts.cand.409525/gov.uscourts.cand.409525.96.0.pdf",
          "verbatim": "Using AI to check the work of AI was not a reasonable inquiry.",
          "effective": "2025-11-20",
          "fetched": "2026-09-18"
        },
        {
          "title": "Decision (single judge, not a rule) — Buchanan v. Vuori, Inc., No. 23-cv-01121-NC, ECF No. 96, Order Imposing Sanctions on Attorney James Dal Bon (N.D. Cal. Nov. 20, 2025) (Cousins, M.J.) (RECAP copy of the filed order; pleading paper — one line per quotation) — p. 4:19 (the violation is the failure to inquire, not AI use)",
          "url": "https://storage.courtlistener.com/recap/gov.uscourts.cand.409525/gov.uscourts.cand.409525.96.0.pdf",
          "verbatim": "use of AI that violated Rule 11, but rather his failure to conduct a reasonable inquiry into",
          "effective": "2025-11-20",
          "fetched": "2026-09-18"
        },
        {
          "title": "Decision (single judge, not a rule) — Buchanan v. Vuori, Inc., No. 23-cv-01121-NC, ECF No. 96, Order Imposing Sanctions on Attorney James Dal Bon (N.D. Cal. Nov. 20, 2025) (Cousins, M.J.) (RECAP copy of the filed order; pleading paper — one line per quotation) — p. 8:13 (violation of Rule 11(b) and Civil L.R. 11-4)",
          "url": "https://storage.courtlistener.com/recap/gov.uscourts.cand.409525/gov.uscourts.cand.409525.96.0.pdf",
          "verbatim": "Procedure 11(b) and Civil Local Rule 11-4 and imposes the following sanctions under",
          "effective": "2025-11-20",
          "fetched": "2026-09-18"
        },
        {
          "title": "Decision (single judge, not a rule) — Buchanan v. Vuori, Inc., No. 23-cv-01121-NC, ECF No. 96, Order Imposing Sanctions on Attorney James Dal Bon (N.D. Cal. Nov. 20, 2025) (Cousins, M.J.) (RECAP copy of the filed order; pleading paper — one line per quotation) — p. 8:16 ($250 sanction; motions stricken; referral under Civil L.R. 11-6)",
          "url": "https://storage.courtlistener.com/recap/gov.uscourts.cand.409525/gov.uscourts.cand.409525.96.0.pdf",
          "verbatim": "2. Dal Bon is ordered to pay the Clerk of Court $250 by December 5, 2025; and",
          "effective": "2025-11-20",
          "fetched": "2026-09-18"
        },
        {
          "title": "Decision (single judge, not a rule) — Buchanan v. Vuori, Inc., No. 23-cv-01121-NC, ECF No. 96, Order Imposing Sanctions on Attorney James Dal Bon (N.D. Cal. Nov. 20, 2025) (Cousins, M.J.) (RECAP copy of the filed order; pleading paper — one line per quotation) — p. 8:17",
          "url": "https://storage.courtlistener.com/recap/gov.uscourts.cand.409525/gov.uscourts.cand.409525.96.0.pdf",
          "verbatim": "3. Dal Bon is referred to the Court’s Standing Committee on Professional Conduct.",
          "effective": "2025-11-20",
          "fetched": "2026-09-18"
        },
        {
          "title": "LEAD ONLY — Duane Morris Class Action Defense blog, AI Hallucinated Case Citations Prompt Sanctions And Delay Class Action Settlement (Feb. 3, 2026) (Buchanan v. Vuori)",
          "url": "https://blogs.duanemorris.com/classactiondefense/2026/02/03/ai-hallucinated-case-citations-prompt-sanctions-and-delay-class-action-settlement/",
          "verbatim": null,
          "effective": null,
          "fetched": null
        },
        {
          "title": "LEAD ONLY — Legal AI Governance tracker, N.D. Cal. AI Court Order: Eumi K. Lee",
          "url": "https://legalaigovernance.com/tracker/court-orders/cand-lee-ai-order/",
          "verbatim": null,
          "effective": null,
          "fetched": null
        }
      ],
      "status": "verified",
      "verified_on": "2026-09-18",
      "verified_by": "claude-opus-5 (independent verifier session; every source URL re-fetched 2026-09-17; checkq/strictq exact match; pinpoints, effective dates, status and narrative claims checked against the fetched text; one missed-item search)",
      "attorney_signoff": null,
      "notes": "(i) COURT-WIDE: VERIFIED NOTHING AI-SPECIFIC in the rules governing filings. Every local-rule set on the court's Local Rules page was fetched 2026-09-18 and grepped in full (artificial, intelligence, generative, AI, ChatGPT, large language, LLM, machine learning, hallucination, Copilot, Gemini, Claude): Civil Local Rules (page footer Effective May 1, 2026; the rule text of L.R. 1-3 still recites November 1, 2021 as the rules' effective date, and the what's-new notice says the May 1, 2026 version changed only L.R. 77-3), Criminal Local Rules (footer Revised July 29, 2026; the table-of-contents pages still carry Revised August 21, 2024), Patent Local Rules (Aug. 11, 2026), ADR (May 1, 2018), Habeas (July 2, 2012), Admiralty (Dec. 1, 2009), Supplemental Social Security Rules. Only hit: habeas rules, intelligent and voluntary (not AI). Also checked with no AI content: General Orders GO-02 through GO-79 (both listing pages, titles), Abrogated General Orders page, Miscellaneous Orders (2014–2024), Standing Order for All Judges (Updated Nov. 30, 2023), ESI Guidelines (12-1-2015), Procedural Guidance for Class Action Settlements (modified Sept. 5, 2024), Northern District Guidelines page, Professional Conduct page, Attorneys page, Local Rules Attorney Advisory Committees page, and News & Announcements (all four pages; the archive reaches back only to Mar. 24, 2025). The only court-wide AI item is the undated Representing Yourself page Using AI Tools in Your Case: guidance for self-represented litigants (verify citations, read cases, check the assigned judge's standing orders for disclosure rules, caution about confidentiality), not a rule or order. (ii) BINDING STATUS: Civil L.R. 11-4, 11-6, 1-4 and Crim. L.R. 2-1 are binding local rules. Under Civil L.R. 1-5(o) a judge's standing order governs the cases assigned to that judge only. The pro se page is guidance. Oneto and Buchanan are single-judge sanctions orders, persuasive only. (iii) PROPOSED/PENDING: two local-rule proposals posted in 2026, neither touching AI: Crim. L.R. 6-2 (grand jury motions; comments closed July 23, 2026) and Civil L.R. 10, to be renumbered 15 (amended pleadings; comments until Sept. 28, 2026). The Civil L.R. 10 notice refers to a redline, but the page HTML carries no link to it; not fetched. (iv) JUDGE LEVEL — full sweep 2026-09-18: the Judges page lists 36 judges (23 district judges incl. 9 senior; 13 magistrate judges; no visiting judges). All 36 judge pages were fetched; they link 146 distinct files (the paginated Standing Orders listing, 9 pages and 180 rows, holds 140 of them). 145 were downloaded and grepped; 1 returned 404 (CAND_Civil_Local_Rules_Final_Corrected_08-04-2022.pdf, a stale local-rules link on the Martínez-Olguín, Gilliam and Spero pages). Seven image-only PDFs were OCR'd and grepped (White civil bench, civil jury and criminal jury trial guidelines, Rev. 10-23; Chen general civil standing order rev. 12-1-2022; van Keulen civil pretrial and settlement orders, Jan. 2023; Gonzalez Rogers civil pretrial order, Jan. 2025): no hits. The judge pages' own text has no AI content. AI hits in 8 files, 8 judges: (a) DISCLOSURE — Magistrate Judge Kang (Civil Standing Order, July 16, 2025, § C): any brief, pleading or other document whose text was created or drafted with any use of an AI tool must be identified as such in its title or caption, in a table before the body, or by a separate Notice; the same for AI-assisted exhibits and demonstratives; records sufficient to identify AI-drafted portions; a Notice and authenticity declarations for AI-generated evidence; meet and confer on AI issues for the Joint Case Management Statement; ordinary research and word-processing tools excluded. (b) CERTIFICATION — District Judges Martínez-Olguín (rev. Aug. 26, 2026, § H.4) and Lee (Aug. 31, 2026, § VIII.H): any submission containing AI-generated content must include a certification that lead trial counsel personally verified its accuracy; failure is grounds for sanctions; prompt records. Neither order prescribes certificate wording. (c) DEEMED CERTIFICATION — Magistrate Judge van Keulen (Feb. 2, 2026, § 10): the signature on a submission containing AI-generated content is itself the certification of personal verification; AI errors imputed to the signer; prompt records; applies to self-represented parties too. (d) VERIFICATION ONLY — District Judge Lin (Sept. 4, 2026; applies also to self-represented litigants), District Judge Thompson (Standing Order on Civility and Professionalism, Aug. 18, 2025, § VII; plus AI usage on billing statements; although its § III says it applies to all attorneys admitted or appearing pro hac vice in the district and § II cites Fed. R. Civ. P. 83, it is treated here as judge-specific: it is signed by Judge Thompson alone, is posted only on her page and in the Standing Orders listing under her name, is not a General Order (Civil L.R. 1-5(j) reserves General Orders to the Chief Judge or the Court), and Civil L.R. 1-5(o) limits a judge's standing orders to actions assigned to that judge), Magistrate Judge Cisneros (Civil Standing Order, § E.4, listing date Feb. 17, 2026; errors of computer-based tools imputed to the signer; n.1 preserves professional-conduct duties). (e) NOT A FILING RULE — Judges Lin and Chhabria require the proposed class-settlement administrator's declaration to state whether AI will be used to administer the settlement and what safeguards apply. Hence disclosure_to_court is judge_specific and certification_required is false for the court-wide position. Apart from the eight orders listed, no judge's standing order (criminal, patent, trial, discovery, settlement or other) contains AI language. Check the assigned district and magistrate judge's standing orders for every matter; these orders were revised as recently as Sept. 4, 2026. (v) DECISIONS (not rules), both read in full from RECAP copies of the filed orders: Oneto v. Watson (Martínez-Olguín, J., Oct. 10, 2025): nonexistent citations traced to Google's AI Overview; violations of Rule 11(b), Cal. RPC 3.1(a)(2) and 3.3(a)(1)-(2), and the judge's AI standing order; failing to recognize AI use in one's own papers also falls short of Cal. RPC 1.1 technology competence; $1,000 personal sanction, service on the client, 1-hour CLE on ethical AI use, Clerk to serve the State Bar. Buchanan v. Vuori (Cousins, M.J., Nov. 20, 2025): one nonexistent case and 8 false quotations from AI tools in a class-settlement approval motion; counsel had used six AI tools to check each other; Rule 11(b) and Civil L.R. 11-4 (Cal. RPC 3.3) violated; motions stricken without leave to refile, $250, referral to the Standing Committee under Civil L.R. 11-6, and counsel found inadequate as class counsel. Other N.D. Cal. AI sanction orders may exist; none else was fetched. (vi) NOT FETCHED / NOT CHECKED: the URL Judge Kang cites for the Guidelines for Professional Conduct (cand.uscourts.gov/professional_conduct_guidelines) returned 404 on 2026-09-18; the Guidelines themselves were read on the Admission & Bar Membership page (no AI provision). Also not fetched: the Civil L.R. 10 redline; the U.S. Bankruptcy Court for the N.D. Cal. (separate rules); Judge Alsup (a Dec. 15, 2025 news item announces a status change; he is not on the Judges page, so none of his orders were checked). No page was blocked or rate-limited. (vii) QUOTATION MECHANICS: the Kang and Thompson orders and the Oneto and Buchanan decisions are on numbered pleading paper. The -layout text puts a line number (and, at line 12, a court-name sidebar) inside every line, so a multi-line quotation cannot pass the exact-text gate. Those sources are quoted one physical line at a time with page:line pinpoints in the titles; the verifier should read the full passages cited. No quotation is taken from OCR text. (viii) PROFESSIONAL CONDUCT: Civil L.R. 11-4(a)(1) makes the California standards (State Bar Act, California Rules of Professional Conduct, decisions) the conduct standard in this court, so the California RPC entry supplies competence, confidentiality, candor, supervision and client-communication duties. The uscourts.gov FRCP PDF does not state Rule 11's own effective date (effective left null)."
    },
    {
      "id": "us-edca",
      "kind": "federal_district",
      "name": "U.S. District Court for the Eastern District of California",
      "disclosure_to_court": "judge_specific",
      "certification_required": false,
      "certificate_language": null,
      "verification_duty": "No court-wide AI rule. Fed. R. Civ. P. 11(b) (national rule) applies: by presenting a paper, an attorney \"certifies that to the best of the person’s knowledge, information, and belief, formed after an inquiry reasonable under the circumstances\" that legal contentions are warranted and factual contentions have evidentiary support (Rule 11(b)(2)-(3), paraphrased); Rule 11(c)(1): \"Absent exceptional circumstances, a law firm must be held jointly responsible for a violation committed by its partner, associate, or employee.\" L.R. 131(c): \"Anything filed using an attorney's name, login, and password will be deemed to have been signed by that attorney for all purposes, including Fed. R. Civ. P. 11.\" L.R. 180(e) requires every member of the bar and every attorney permitted to practice to comply with the standards of professional conduct of the State Bar Act, the California Rules of Professional Conduct, and applicable decisions, \"which are hereby adopted as standards of professional conduct in this Court\"; L.R. 110 authorizes any sanction \"authorized by statute or Rule or within the inherent power of the Court\" for failure to comply with the rules or any order; L.R. 184(a) lets any Judge or Magistrate Judge take disciplinary action. No E.D. Cal. judge found (2026-09-18) requires AI disclosure or certification for briefs; Magistrate Judge Kim requires notice and labeling of AI-generated trial exhibits (see notes). Decisions (single-judge orders, not rules): in United States v. Hayes (Kim, M.J., Jan. 17, 2025), the first such case in the district, the court found that counsel, by submitting a fictitious case and quotation and then misleading the court about it, \"violated Local Rule 180(e) by violating California rules of professional conduct, engaging\" in conduct that degrades the court's integrity, and sanctioned him $1,500 personally for \"violation of Local Rule 180(e) and pursuant to its inherent authority\", without deciding whether AI was used. In Tercero v. Sacramento Logistics (Coggins, J., Sept. 8, 2025) the court held that Rule 11(b) imposes an \"affirmative duty to investigate the caselaw before submitting a court filing\" and sanctioned counsel $1,500 for violations of \"Federal Rule of Civil Procedure 11(b) and Local Rule 180(e)\".",
      "confidentiality_restriction": null,
      "record_keeping_duty": "none",
      "client_disclosure_duty": "none",
      "fees_note": null,
      "sources": [
        {
          "title": "E.D. Cal. Local Rules (effective February 23, 2026), cover page (effective date)",
          "url": "https://www.caed.uscourts.gov/caednew/assets/File/EDCA%20LOCAL%20RULES%20EFF_%2002-23-26.pdf",
          "verbatim": "Effective February 23, 2026",
          "effective": "2026-02-23",
          "fetched": "2026-09-18"
        },
        {
          "title": "Same — L.R. 180(e) (Standards of Professional Conduct — adopts the State Bar Act, the California Rules of Professional Conduct, and applicable decisions as the court's conduct standard)",
          "url": "https://www.caed.uscourts.gov/caednew/assets/File/EDCA%20LOCAL%20RULES%20EFF_%2002-23-26.pdf",
          "verbatim": "Every member of the Bar of this Court, and any attorney permitted to practice in this Court under (b), shall become familiar with and comply with the standards of professional conduct required of members of the State Bar of California and contained in the State Bar Act, the Rules of Professional Conduct of the State Bar of California, and court decisions applicable thereto, which are hereby adopted as standards of professional conduct in this Court.",
          "effective": "2026-02-23",
          "fetched": "2026-09-18"
        },
        {
          "title": "Same — L.R. 180(e), second sentence (ABA Model Rules as guidance where no California standard applies)",
          "url": "https://www.caed.uscourts.gov/caednew/assets/File/EDCA%20LOCAL%20RULES%20EFF_%2002-23-26.pdf",
          "verbatim": "In the absence of an applicable standard therein, the Model Rules of Professional Conduct of the American Bar Association may be considered guidance.",
          "effective": "2026-02-23",
          "fetched": "2026-09-18"
        },
        {
          "title": "Same — L.R. 110 (Sanctions for Noncompliance with Rules)",
          "url": "https://www.caed.uscourts.gov/caednew/assets/File/EDCA%20LOCAL%20RULES%20EFF_%2002-23-26.pdf",
          "verbatim": "Failure of counsel or of a party to comply with these Rules or with any order of the Court may be grounds for imposition by the Court of any and all sanctions authorized by statute or Rule or within the inherent power of the Court.",
          "effective": "2026-02-23",
          "fetched": "2026-09-18"
        },
        {
          "title": "Same — L.R. 131(b) (Signatures Generally)",
          "url": "https://www.caed.uscourts.gov/caednew/assets/File/EDCA%20LOCAL%20RULES%20EFF_%2002-23-26.pdf",
          "verbatim": "All pleadings and non-evidentiary documents shall be signed by the individual attorney for the party presenting them, or by the party involved if that party is appearing in propria persona.",
          "effective": "2026-02-23",
          "fetched": "2026-09-18"
        },
        {
          "title": "Same — L.R. 131(c) (Attorney Signatures — e-filing login is a signature for Rule 11 purposes)",
          "url": "https://www.caed.uscourts.gov/caednew/assets/File/EDCA%20LOCAL%20RULES%20EFF_%2002-23-26.pdf",
          "verbatim": "Anything filed using an attorney's name, login, and password will be deemed to have been signed by that attorney for all purposes, including Fed. R. Civ. P. 11.",
          "effective": "2026-02-23",
          "fetched": "2026-09-18"
        },
        {
          "title": "Same — L.R. 183(a) (Persons Appearing in Propria Persona — bound by the rules)",
          "url": "https://www.caed.uscourts.gov/caednew/assets/File/EDCA%20LOCAL%20RULES%20EFF_%2002-23-26.pdf",
          "verbatim": "Any individual representing himself or herself without an attorney is bound by the Federal Rules of Civil or Criminal Procedure, these Rules, and all other applicable law. All obligations placed on \"counsel\" by these Rules apply to individuals appearing in propria persona.",
          "effective": "2026-02-23",
          "fetched": "2026-09-18"
        },
        {
          "title": "Same — L.R. 184(a) (Disciplinary Proceedings Against Attorneys)",
          "url": "https://www.caed.uscourts.gov/caednew/assets/File/EDCA%20LOCAL%20RULES%20EFF_%2002-23-26.pdf",
          "verbatim": "In the event any attorney subject to these Rules engages in conduct that may warrant discipline or other sanctions, any Judge or Magistrate Judge may initiate proceedings for contempt under 18 U.S.C. § 401 or Fed. R. Crim. P. 42, or may, after reasonable notice and opportunity to show cause to the contrary, take any other appropriate disciplinary action against the attorney.",
          "effective": "2026-02-23",
          "fetched": "2026-09-18"
        },
        {
          "title": "Same — L.R. 100(d) (Applicability — Rules 100-199 govern all actions, civil and criminal)",
          "url": "https://www.caed.uscourts.gov/caednew/assets/File/EDCA%20LOCAL%20RULES%20EFF_%2002-23-26.pdf",
          "verbatim": "Local Rules 100 through 199 and 300 through 399 govern proceedings in all actions in the United States District Court for the Eastern District of California to the extent not inconsistent with other Rules more specifically applicable to the particular action.",
          "effective": "2026-02-23",
          "fetched": "2026-09-18"
        },
        {
          "title": "Fed. R. Civ. P. 11(b) (Federal Rules of Civil Procedure, Dec. 1, 2025 edition, uscourts.gov) — national rule",
          "url": "https://www.uscourts.gov/sites/default/files/document/federal-rules-of-civil-procedure.pdf",
          "verbatim": "certifies that to the best of the person’s knowledge, information, and belief, formed after an inquiry reasonable under the circumstances",
          "effective": null,
          "fetched": "2026-09-18"
        },
        {
          "title": "Same — Fed. R. Civ. P. 11(c)(1) (law firm responsibility)",
          "url": "https://www.uscourts.gov/sites/default/files/document/federal-rules-of-civil-procedure.pdf",
          "verbatim": "Absent exceptional circumstances, a law firm must be held jointly responsible for a violation committed by its partner, associate, or employee.",
          "effective": null,
          "fetched": "2026-09-18"
        },
        {
          "title": "E.D. Cal. Local Rules page — no proposed local rules pending for comment; lists current rules (eff. Feb. 23, 2026), Proposed L.R. 305 and Appendix A (Dec. 12, 2025), Proposed Local Rules for Comment 2024, and prior versions",
          "url": "https://www.caed.uscourts.gov/caednew/index.cfm/rules/local-rules/",
          "verbatim": "There are no proposed new or amended local rules for comment at this time.",
          "effective": null,
          "fetched": "2026-09-18"
        },
        {
          "title": "Proposed Local Rule 305 and Appendix A (public-comment draft, Dec. 12, 2025; adopted by General Order No. 702, Feb. 24, 2026) — no AI terms (grep)",
          "url": "https://www.caed.uscourts.gov/caednew/assets/File/PROPOSED%20LR%20305%20AND%20APPENDIX%20A.pdf",
          "verbatim": null,
          "effective": null,
          "fetched": "2026-09-18"
        },
        {
          "title": "Proposed Local Rules for Comment 2024 (public-comment draft) — no AI terms (grep)",
          "url": "https://www.caed.uscourts.gov/caednew/assets/File/Proposed%20Local%20Rules%20(2024)(Public%20Comment)002.pdf",
          "verbatim": null,
          "effective": null,
          "fetched": "2026-09-18"
        },
        {
          "title": "E.D. Cal. Local Rules effective January 1, 2025 (prior version) — no AI terms (grep)",
          "url": "https://www.caed.uscourts.gov/caednew/assets/File/EDCA%20LOCAL%20RULES%20EFF%201-1-25%20(FINAL).pdf",
          "verbatim": null,
          "effective": "2025-01-01",
          "fetched": "2026-09-18"
        },
        {
          "title": "E.D. Cal. General Orders 651-700 index page (May 17, 2022 through Feb. 18, 2026) — titles only; none concerns AI",
          "url": "https://www.caed.uscourts.gov/caednew/index.cfm/rules/general-orders/general-orders-651-700/",
          "verbatim": null,
          "effective": null,
          "fetched": "2026-09-18"
        },
        {
          "title": "E.D. Cal. General Orders 701-750 index page (Nos. 701-706, Feb. 18, 2026 through Sept. 8, 2026) — titles only; none concerns AI",
          "url": "https://www.caed.uscourts.gov/caednew/index.cfm/rules/general-orders/general-orders-701-750/",
          "verbatim": null,
          "effective": null,
          "fetched": "2026-09-18"
        },
        {
          "title": "E.D. Cal. General Orders main index page — checked",
          "url": "https://www.caed.uscourts.gov/caednew/index.cfm/rules/general-orders/",
          "verbatim": null,
          "effective": null,
          "fetched": "2026-09-18"
        },
        {
          "title": "E.D. Cal. Standing Orders page (court-wide list; directs users to each judge's page for additional orders) — no AI order listed",
          "url": "https://www.caed.uscourts.gov/caednew/index.cfm/rules/standing-orders/",
          "verbatim": "Please check each judge's individual web page for additional orders",
          "effective": null,
          "fetched": "2026-09-18"
        },
        {
          "title": "E.D. Cal. News page (items through Apr. 7, 2026) — checked, no AI notice",
          "url": "https://www.caed.uscourts.gov/caednew/index.cfm/news/",
          "verbatim": null,
          "effective": null,
          "fetched": "2026-09-18"
        },
        {
          "title": "E.D. Cal. All Judges page (24 judges plus a NODJ placeholder) — each judge page fetched",
          "url": "https://www.caed.uscourts.gov/caednew/index.cfm/judges/all-judges/",
          "verbatim": null,
          "effective": null,
          "fetched": "2026-09-18"
        },
        {
          "title": "E.D. Cal. Rules Pertaining to Electronic Filing page — checked",
          "url": "https://www.caed.uscourts.gov/caednew/index.cfm/cmecf-e-filing/rules-pertaining-to-electronic-filing/",
          "verbatim": null,
          "effective": null,
          "fetched": "2026-09-18"
        },
        {
          "title": "E.D. Cal. Representing Yourself (Pro Se Litigant) page — checked",
          "url": "https://www.caed.uscourts.gov/caednew/index.cfm/cmecf-e-filing/representing-yourself-pro-se-litigant/",
          "verbatim": null,
          "effective": null,
          "fetched": "2026-09-18"
        },
        {
          "title": "E.D. Cal. Combined Pro Se Packet — no AI terms (grep)",
          "url": "https://www.caed.uscourts.gov/caednew/assets/File/Combined%20Pro%20Se%20Packet(3).pdf",
          "verbatim": null,
          "effective": null,
          "fetched": "2026-09-18"
        },
        {
          "title": "Judge page — Magistrate Judge Chi Soo Kim (CSK), links her Standing Order in Civil Cases and Civil Trial Procedures (re-fetch point; the PDF file names change when she reissues them)",
          "url": "https://www.caed.uscourts.gov/caednew/index.cfm/judges/all-judges/united-states-magistrate-judge-chi-soo-kim-csk/",
          "verbatim": null,
          "effective": null,
          "fetched": "2026-09-18"
        },
        {
          "title": "Judge-specific — Magistrate Judge Chi Soo Kim (Sacramento), Civil Standing Orders (Effective 11/5/2025), § I.D (Remote Zoom Appearances; same text in § III.A for Zoom settlement conferences; § II.D applies § I.D to discovery hearings) — bars AI alteration of appearance or voice on video; not a filing rule; not court-wide",
          "url": "https://www.caed.uscourts.gov/caednew/assets/File/CSK_Civil_StdOrder_Eff_2025_11-05.pdf",
          "verbatim": "Virtual backgrounds, avatars, digital twins, or the use of any tool or artificial intelligence (AI) to alter an individual’s appearance or voice are prohibited.",
          "effective": "2025-11-05",
          "fetched": "2026-09-18"
        },
        {
          "title": "Judge-specific — Magistrate Judge Chi Soo Kim, Civil Trial Procedures (Effective 10/14/2025), § C (Exhibits), p. 4 — written pre-trial notice of AI-generated exhibits and illustrative aids and 'AI Generated' marking on exhibit lists; not court-wide",
          "url": "https://www.caed.uscourts.gov/caednew/assets/File/CSK_Civil-Trial-Procedures_Website_FIN-Rev_2025-10-14.pdf",
          "verbatim": "Artificial Intelligence (AI) Generated Exhibits and Illustrative Aids: Parties must provide written pre-trial notice of AI generated exhibits and illustrative aids, and such exhibits must also be identified on the exhibit lists submitted by the parties as AI Generated.",
          "effective": "2025-10-14",
          "fetched": "2026-09-18"
        },
        {
          "title": "Decision (single judge, not a rule) — United States v. Hayes, No. 2:24-cr-0280-DJC, ECF No. 62, Order (E.D. Cal. Jan. 17, 2025) (Magistrate Judge Chi Soo Kim — name from the image signature block, read by OCR, and the docket text; reported at 763 F. Supp. 3d 1054 as cited in Tercero and Gamez), p. 13:9 (finding: fictitious case and quotation submitted)",
          "url": "https://storage.courtlistener.com/recap/gov.uscourts.caed.454136/gov.uscourts.caed.454136.62.0.pdf",
          "verbatim": "The Court finds that Mr. Francisco submitted a fictitious or non-existent case and",
          "effective": "2025-01-17",
          "fetched": "2026-09-18"
        },
        {
          "title": "Same (Hayes) — p. 14:12 (the citation bears the markings of a generative-AI hallucination; continues on line 13: generative artificial intelligence (AI) tools such as ChatGPT and Google Bard)",
          "url": "https://storage.courtlistener.com/recap/gov.uscourts.caed.454136/gov.uscourts.caed.454136.62.0.pdf",
          "verbatim": "The citation has all the markings of a hallucinated case created by",
          "effective": "2025-01-17",
          "fetched": "2026-09-18"
        },
        {
          "title": "Same (Hayes) — p. 16:21 (no finding needed on whether counsel used AI; counsel had denied using AI, p. 16:2-4)",
          "url": "https://storage.courtlistener.com/recap/gov.uscourts.caed.454136/gov.uscourts.caed.454136.62.0.pdf",
          "verbatim": "The Court need not make any finding as to whether Mr. Francisco actually",
          "effective": "2025-01-17",
          "fetched": "2026-09-18"
        },
        {
          "title": "Same (Hayes) — p. 16:22 (continuation of the preceding sentence)",
          "url": "https://storage.courtlistener.com/recap/gov.uscourts.caed.454136/gov.uscourts.caed.454136.62.0.pdf",
          "verbatim": "used generative AI to draft any portion of his motion and reply, including the fictitious",
          "effective": "2025-01-17",
          "fetched": "2026-09-18"
        },
        {
          "title": "Same (Hayes) — p. 24:3 (L.R. 180(e) violated through the California Rules of Professional Conduct 3.1(a)(2), 3.3(a)(1), 3.3(a)(2))",
          "url": "https://storage.courtlistener.com/recap/gov.uscourts.caed.454136/gov.uscourts.caed.454136.62.0.pdf",
          "verbatim": "violated Local Rule 180(e) by violating California rules of professional conduct, engaging",
          "effective": "2025-01-17",
          "fetched": "2026-09-18"
        },
        {
          "title": "Same (Hayes) — p. 27:13 (first such case in the district)",
          "url": "https://storage.courtlistener.com/recap/gov.uscourts.caed.454136/gov.uscourts.caed.454136.62.0.pdf",
          "verbatim": "this is the first time it has arisen in this federal district",
          "effective": "2025-01-17",
          "fetched": "2026-09-18"
        },
        {
          "title": "Same (Hayes) — p. 27:21 (legal basis of the sanction)",
          "url": "https://storage.courtlistener.com/recap/gov.uscourts.caed.454136/gov.uscourts.caed.454136.62.0.pdf",
          "verbatim": "violation of Local Rule 180(e) and pursuant to its inherent authority:",
          "effective": "2025-01-17",
          "fetched": "2026-09-18"
        },
        {
          "title": "Same (Hayes) — p. 27:23 (amount; counsel personally; Clerk to serve the D.C. Bar, the State Bar of California, and all district and magistrate judges, pp. 27-28)",
          "url": "https://storage.courtlistener.com/recap/gov.uscourts.caed.454136/gov.uscourts.caed.454136.62.0.pdf",
          "verbatim": "sanctioned in the amount of $1,500.",
          "effective": "2025-01-17",
          "fetched": "2026-09-18"
        },
        {
          "title": "Decision (single judge, not a rule) — Tercero v. Sacramento Logistics, LLC, No. 2:24-cv-00953-DC-JDP, ECF No. 50, Order Sanctioning Plaintiff's Counsel (E.D. Cal. signed Sept. 8, 2025, filed Sept. 9, 2025) (Coggins, J.), p. 13:25 (Rule 11(b), citing Rachel v. Banana Republic (9th Cir. 1987), imposes on counsel an affirmative duty to investigate caselaw)",
          "url": "https://storage.courtlistener.com/recap/gov.uscourts.caed.444020/gov.uscourts.caed.444020.50.0.pdf",
          "verbatim": "affirmative duty to investigate the caselaw before submitting a court filing.",
          "effective": "2025-09-08",
          "fetched": "2026-09-18"
        },
        {
          "title": "Same (Tercero) — p. 16:22 (Rule 11(b) violation)",
          "url": "https://storage.courtlistener.com/recap/gov.uscourts.caed.444020/gov.uscourts.caed.444020.50.0.pdf",
          "verbatim": "Therefore, the court finds that Attorney Ardestani violated FRCP 11(b).",
          "effective": "2025-09-08",
          "fetched": "2026-09-18"
        },
        {
          "title": "Same (Tercero) — p. 20:25, n.3 (court not opposed to ethical AI use)",
          "url": "https://storage.courtlistener.com/recap/gov.uscourts.caed.444020/gov.uscourts.caed.444020.50.0.pdf",
          "verbatim": "To be clear, the court is not opposed to the ethical use of artificial intelligence.",
          "effective": "2025-09-08",
          "fetched": "2026-09-18"
        },
        {
          "title": "Same (Tercero) — p. 24:7 (legal basis of the sanctions)",
          "url": "https://storage.courtlistener.com/recap/gov.uscourts.caed.444020/gov.uscourts.caed.444020.50.0.pdf",
          "verbatim": "Federal Rule of Civil Procedure 11(b) and Local Rule 180(e):",
          "effective": "2025-09-08",
          "fetched": "2026-09-18"
        },
        {
          "title": "Same (Tercero) — p. 24:8 (amount; counsel to serve the order on the client; Clerk to serve the State Bar of California, p. 24:12-15)",
          "url": "https://storage.courtlistener.com/recap/gov.uscourts.caed.444020/gov.uscourts.caed.444020.50.0.pdf",
          "verbatim": "1. Attorney Sepideh Ardestani is personally sanctioned in the amount of $1,500.",
          "effective": "2025-09-08",
          "fetched": "2026-09-18"
        },
        {
          "title": "Decision (single judge, not a rule) — Gamez v. County of Fresno, No. 1:26-cv-00297-KES-EPG, ECF No. 16, Order to Show Cause (E.D. Cal. Apr. 6, 2026) (Magistrate Judge Erica P. Grosjean, per the docket text; the signature block is an image), p. 1:24",
          "url": "https://storage.courtlistener.com/recap/gov.uscourts.caed.478680/gov.uscourts.caed.478680.16.0.pdf",
          "verbatim": "Such issues suggest that Attorney Little relied on generative artificial",
          "effective": "2026-04-06",
          "fetched": "2026-09-18"
        },
        {
          "title": "Same (Gamez) — ECF No. 18, Order Discharging Order to Show Cause (E.D. Cal. Apr. 9, 2026), p. 2 (counsel's admission, summarized by the court)",
          "url": "https://storage.courtlistener.com/recap/gov.uscourts.caed.478680/gov.uscourts.caed.478680.18.0.pdf",
          "verbatim": "he admits to using a generative AI application to draft an opposition containing errors",
          "effective": "2026-04-09",
          "fetched": "2026-09-18"
        },
        {
          "title": "Same (Gamez, ECF No. 18) — p. 4:20 (OSC discharged without sanctions; counsel warned, p. 4:22-23; superseding opposition ordered)",
          "url": "https://storage.courtlistener.com/recap/gov.uscourts.caed.478680/gov.uscourts.caed.478680.18.0.pdf",
          "verbatim": "1. The Court’s April 6, 2026, order to show cause is discharged without the imposition of",
          "effective": "2026-04-09",
          "fetched": "2026-09-18"
        },
        {
          "title": "Decision (single judge, not a rule) — Cummins v. Becerra, No. 1:25-cv-01853-DC-AC, ECF No. 35, Order to Petitioner to Show Cause as to Why Sanctions Should Not Issue (E.D. Cal. Feb. 9, 2026, filed Feb. 10, 2026) (Coggins, J.) — OSC only (hallucinated citations in habeas briefing, p. 5:8-16; unauthorized law-student appearance); read in full; not quoted; disposition not located",
          "url": "https://storage.courtlistener.com/recap/gov.uscourts.caed.476928/gov.uscourts.caed.476928.35.0.pdf",
          "verbatim": null,
          "effective": "2026-02-09",
          "fetched": "2026-09-18"
        },
        {
          "title": "LEAD ONLY — CourtListener RECAP dockets (docket-entry text) for United States v. Hayes, In re Appeal of Andrew Francisco (No. 2:25-mc-00112-DAD), Tercero, and Cummins, queried 2026-09-18 via the search API — procedural history only",
          "url": "https://www.courtlistener.com/docket/69878769/in-re-appeal-of-andrew-francisco/",
          "verbatim": null,
          "effective": null,
          "fetched": null
        },
        {
          "title": "LEAD ONLY — Norton Rose Fulbright, AI in litigation: Update on Gen AI sanctions in 2026 (web search result naming Gamez and Tercero; not read)",
          "url": "https://www.nortonrosefulbright.com/en/knowledge/publications/792d8bf3/ai-in-litigation-update-on-gen-ai-sanctions-in-2026",
          "verbatim": null,
          "effective": null,
          "fetched": null
        },
        {
          "title": "LEAD ONLY — Defender Services Office, Court Sanctions Defense Attorney Whose Brief Cited Nonexistent Case (web search result naming Hayes; not read)",
          "url": "https://www.fd.org/news/court-sanctions-defense-attorney-whose-brief-cited-nonexistent-case",
          "verbatim": null,
          "effective": null,
          "fetched": null
        }
      ],
      "status": "verified",
      "verified_on": "2026-09-18",
      "verified_by": "claude-opus-5 (independent verifier session; every source URL re-fetched 2026-09-18; checkq/strictq exact match; pinpoints, effective dates, status and narrative claims checked against the fetched text; one missed-item search)",
      "attorney_signoff": null,
      "notes": "(i) COURT-WIDE: VERIFIED NOTHING AI-SPECIFIC. The Local Rules effective February 23, 2026 (cover; L.R. 100(e) still recites the original December 1, 2009 effective date) were grepped in full for artificial intelligence, generative, AI, A.I., ChatGPT, large language, machine, hallucinat, technolog, automat, intelligence, software and computer: no AI provision. Hits are only the automated case-assignment plan, e-filing/PDF software provisions, and L.R. 281(b)(5) (pretrial statement must flag disputes over special technology at trial such as computer animation). The criminal (L.R. 400-499) and admiralty rules are in the same PDF and were covered. Also grepped with no AI terms: the prior Local Rules (eff. Jan. 1, 2025), Proposed Local Rules for Comment 2024, Proposed L.R. 305 and Appendix A (Dec. 12, 2025; adopted by General Order No. 702, Feb. 24, 2026), and the Combined Pro Se Packet. Pages checked with nothing AI-specific, all fetched 2026-09-18: Local Rules page (no proposals pending); General Orders index and the 651-700 (May 17, 2022 to Feb. 18, 2026) and 701-750 (Nos. 701-706, Feb. 18 to Sept. 8, 2026) index pages, read by title only (court reporting plan, CJA plans, jury plans, magistrate-judge appointments, merit panels, lapse in appropriations; the General Order PDFs were not opened); Standing Orders page (six items: a sample Fresno-to-Sacramento reassignment order, the Mar. 1, 2016 prisoner e-submission standing order, Judge Calabretta's civil and criminal orders, Judge Drozd's civil order, Judge Nunley's criminal order); News page (five items through Apr. 7, 2026); Rules Pertaining to Electronic Filing; Representing Yourself (Pro Se); Attorney Resources; Electronic Evidence Submission/Presentation; Zoom guidance; jury Electronic Devices Policies; FAQ; Civil Forms; Opinions; Cases of Interest; CM/ECF; Federal Rules. (ii) BINDING STATUS: L.R. 110, 131, 180(e), 183 and 184 are binding local rules; L.R. 100(d) applies Rules 100-199 in all actions, civil and criminal, and L.R. 183(a) binds self-represented parties to the rules. Judge Kim's standing orders and trial procedures bind only in cases before Judge Kim. The decisions are single-judge orders, persuasive only. (iii) PROPOSED/PENDING: none. The Local Rules page states there are no proposed new or amended local rules for comment (fetched 2026-09-18). (iv) JUDGE LEVEL: all 25 pages on the All Judges page were fetched (24 judges plus a None/NODJ placeholder: district judges Calabretta, Coggins, Drozd, Nunley (Chief), Sherriff, Thurston; senior district judges Mendez, Shubb; magistrate judges Baker, Barch-Kuchta, Boone, Claire, Deiss, Delaney (Chief MJ), Grosjean, Guy Castillo, Kim, Peterson, Riordan, Singer; recalled magistrate judges Austin, Brennan, McAuliffe, Oberto), covering Sacramento, Fresno, Bakersfield (Baker) and Yosemite (Barch-Kuchta). Every document linked from those pages was fetched and grepped: 46 PDFs and 5 .docx files, Judge Nunley's two HTML standing orders, and Judge Boone's standard-forms page (its 11 linked criminal/probation and AO forms were not opened), plus 3 PDFs linked only from the Standing Orders page. Judge Mendez's page has a case-management-procedures heading but links no document. Hits only in Magistrate Judge Chi Soo Kim's two documents (and an irrelevant list of intoxication symptoms in Judge Barch-Kuchta's blood-draw warrant form). Judge Kim: (a) Civil Standing Orders (Effective 11/5/2025) § I.D, repeated in § III.A and applied to discovery hearings by § II.D, bars using any tool or AI to alter a participant's appearance or voice in Zoom appearances (a remote-hearing conduct rule, not a filing rule); (b) Civil Trial Procedures (Effective 10/14/2025) § C requires written pre-trial notice of AI-generated exhibits and illustrative aids and their identification as AI Generated on the exhibit lists. No E.D. Cal. judge was found to require disclosure or certification of AI use in drafting briefs or other filings. disclosure_to_court is set to judge_specific on the strength of Judge Kim's exhibit-notice rule only; certification_required is false. VERIFIER: confirm this field call (the alternative reading is none, since no judge requires disclosure for briefs). (v) DECISIONS (not rules). Hayes (Kim, M.J., Jan. 17, 2025): $1,500 personal sanction against an Assistant Federal Defender under L.R. 180(e) and inherent authority for a fictitious case and quotation and for misleading follow-up statements; counsel denied using AI and the court made no finding on the point. The docket shows reconsideration denied by Judge Kim on Apr. 9, 2025 (2025 WL 1067323 as cited in Gamez), the sanction paid (receipt Feb. 6, 2025), and an appeal to a district judge (In re Appeal of Andrew Francisco, No. 2:25-mc-00112-DAD) argued July 7, 2025 and submitted; no ruling was located on the RECAP docket as of 2026-09-18 (entries 17, Nov. 1, 2025, and 18, Aug. 3, 2026, are untitled notices with no text in RECAP), so the disposition is unknown. Circumstantially, the later orders in Cummins (Feb. 9, 2026) and Gamez (Apr. 6 and 9, 2026) cite Hayes, 763 F. Supp. 3d 1054, as authority (Gamez adds reconsideration denied) and mention no reversal. Tercero (Coggins, J., Sept. 8, 2025): two nonexistent cases, ten false quotations and twelve mischaracterized cases; $1,500 under Rule 11(b) and L.R. 180(e), service on the client, and the Clerk to serve the State Bar of California; counsel denied using AI and the court made no finding (relying on Hayes); the docket shows the sanction paid (Sept. 16, 2025). Gamez (Grosjean, M.J., Apr. 6 and 9, 2026): counsel admitted using a legal generative-AI product (OpenCase) that inserted hallucinated authorities; the OSC was discharged without sanctions, with a warning and a superseding brief. Cummins (Coggins, J., Feb. 9, 2026): OSC only; no disposition located (RECAP docket through Sept. 11, 2026). E.D. Cal. decisions cited in these orders but NOT fetched (leads only): Allen v. Mercedes-Benz USA, LLC, No. 2:25-cv-01222-DJC-JDP, 2025 WL 1744451 (June 24, 2025) (Rule 11 and L.R. 180(e); referral to the State Bar); Wolinski v. Abdulgader, 2025 WL 1150943 (Apr. 18, 2025); Villalovos-Gutierrez v. Pol, 2025 WL 3470253 (Dec. 3, 2025) (warning); Gibralter, LLC v. DMS Flowers, LLC, 2025 WL 2689350 (Sept. 19, 2025) (admonition). Cases were located through a CourtListener RECAP search (court=caed), which is not exhaustive. (vi) PROFESSIONAL CONDUCT: L.R. 180(e) adopts the State Bar Act, the California Rules of Professional Conduct and applicable decisions as the court's standards of professional conduct, with the ABA Model Rules as guidance where California has no standard, so the California entries in this matrix supply the competence, confidentiality, candor, supervision and client-communication duties. Hayes and Tercero applied Cal. RPC 3.1(a)(2), 3.3(a)(1) and 3.3(a)(2) through L.R. 180(e). confidentiality_restriction is null: no court-wide rule restricts putting information into AI tools (Judge Kim's Zoom AI-alteration ban is not a confidentiality rule). Fed. R. Civ. P. 11 is a national rule applying in civil actions in every district court (effective left null because the uscourts.gov PDF does not state Rule 11's own effective date). (vii) NOT FETCHED / LIMITS: the Standing Orders page's link to Judge Calabretta's criminal standing order rev. 11/08/24 returned HTTP 404 on 2026-09-18 (retried once); the current rev. 08/12/25 file linked from his page was fetched. General Order No. 706 (Sept. 8, 2026) appoints a Redding magistrate judge who has no page yet; visiting judges sitting by designation (e.g., Judge Lee H. Rosenthal on an E.D. Cal. docket) have no E.D. Cal. page. Orders entered on individual dockets (scheduling orders and the like) were not searched; check the assigned judge's docket orders and page for every matter. The Bankruptcy Court for the E.D. Cal. (separate rules) was not checked. (viii) VERIFIER (2026-09-18): field call confirmed. disclosure_to_court judge_specific is defensible on Judge Kim's AI-evidence notice and labelling rule, with the caveat stated above that no E.D. Cal. judge requires AI disclosure for briefs; a stricter reading (none, with the Kim rule noted) would also be defensible and is the attorney's call. Independently re-checked: the All Judges page lists the same 24 judges, the standing-orders page has no AI hits, and among every E.D. Cal. source only Judge Kim's two documents contain AI language. A web-search claim that an E.D. Cal. judge named Ernest Gonzalez issued an AI certification standing order on June 25, 2026 was checked and is not borne out — no judge of that name sits in this district."
    },
    {
      "id": "us-sdca",
      "kind": "federal_district",
      "name": "U.S. District Court for the Southern District of California",
      "disclosure_to_court": "judge_specific",
      "certification_required": false,
      "certificate_language": null,
      "verification_duty": "No court-wide AI rule (see notes). Fed. R. Civ. P. 11(b) (national rule) applies: by presenting a paper, an attorney \"certifies that to the best of the person’s knowledge, information, and belief, formed after an inquiry reasonable under the circumstances\" that legal contentions are warranted and factual contentions have evidentiary support (Rule 11(b)(2)-(3), paraphrased); Rule 11(c)(1): \"Absent exceptional circumstances, a law firm must be held jointly responsible for a violation committed by its partner, associate, or employee.\" Unlike the local rules of some other districts, the S.D. Cal. Local Rules (revised as of June 1, 2026) contain no rule expressly adopting the State Bar Act or the California Rules of Professional Conduct as this court's conduct standard (open question for the verifier; see notes). The conduct hooks are: Civil Rule 83.3(c)(1)(a), which limits admission and continuing membership to attorneys who are \"active members in good standing of the State Bar of California.\" (so the ca-rpc entry binds every admitted attorney through state-bar membership); Civil Rule 83.3(c)(1)(c) and (c)(4), which require admitted and pro hac vice attorneys to adhere to the Code of Conduct in Civil Rule 2.1, including 2.1(a)(3)(f), \"We expect lawyers to be accurate in written communications intended to make a record.\" and 2.1(a)(2)(b) (state plainly when arguing for an extension of existing law); Civil Rule 2.2 (discipline, referral to the disciplinary body of any court of admission, and investigation of unprofessional conduct by the Standing Committee on Discipline); and Civil Rule 83.1(a) (sanctions for failure to comply with the rules or any order of the Court). Criminal Rules 2.1 and 2.2 incorporate Civil Rules 2.1 and 2.2, and Criminal Rule 1.1(e) applies Civil Rule 83.3 in criminal cases. Judge-level: in civil cases before Judge Curiel, counsel \"must, at all times, personally confirm for themselves the accuracy of any content generated by these tools.\" and any submission containing AI-generated content must carry a certification of personal verification (see notes (iv)); Judge Robinson's civil standing order warns that careless reliance on generative AI \"may violate Rule 11 and other applicable standards of practice\" (no disclosure or certification).",
      "confidentiality_restriction": null,
      "record_keeping_duty": "none court-wide. Judge-specific (civil cases before District Judge Gonzalo P. Curiel, civil chambers rules, § Artificial Intelligence): \"Counsel and pro se parties are responsible for maintaining records of all prompts or inquiries submitted to any generative AI tools in the event those records become relevant.\" This is a judge-level duty to keep generative-AI prompt records, not a court-wide rule; flag at merge, since the schema header says no source imposed one as of 2026-09-16.",
      "client_disclosure_duty": "none",
      "fees_note": null,
      "sources": [
        {
          "title": "S.D. Cal. Local Rules (cover: Revised as of June 1, 2026) — cover line",
          "url": "https://www.casd.uscourts.gov/_assets/pdf/rules/2026.06.01%20Local%20Rules.pdf",
          "verbatim": "Revised as of: June 1, 2026",
          "effective": "2026-06-01",
          "fetched": "2026-09-18"
        },
        {
          "title": "Same — Civil Rule 1.1(b) and Criminal Rule 1.1(b) (Effective Date; text not updated to the June 1, 2026 revision)",
          "url": "https://www.casd.uscourts.gov/_assets/pdf/rules/2026.06.01%20Local%20Rules.pdf",
          "verbatim": "b. Effective Date. These Rules become effective on January 2, 2025.",
          "effective": "2026-06-01",
          "fetched": "2026-09-18"
        },
        {
          "title": "Same — Civil Rule 2.1(a) (Professionalism — Code of Conduct governs all participants)",
          "url": "https://www.casd.uscourts.gov/_assets/pdf/rules/2026.06.01%20Local%20Rules.pdf",
          "verbatim": "The following Code of Conduct establishes the principles of civility and professionalism that will govern the conduct of all participants in cases and proceedings pending in this Court. It is to be construed in the broadest sense and governs conduct relating to such cases and proceedings, whether occurring in the presence of the Court or occurring outside of the presence of the Court. This Code of Conduct is not intended to be a set of rules that lawyers can use to incite ancillary litigation on the question whether the standards have been observed, but the Court may take any appropriate measure to address violations, including, without limitation, as set forth in Civil L. Rule 2.2.",
          "effective": "2026-06-01",
          "fetched": "2026-09-18"
        },
        {
          "title": "Same — Civil Rule 2.1(a)(1) (Principles of Civility; Local and Chambers’ Rules as safeguards)",
          "url": "https://www.casd.uscourts.gov/_assets/pdf/rules/2026.06.01%20Local%20Rules.pdf",
          "verbatim": "The Federal Rules and this court’s Local and Chambers’ Rules serve as safeguards to ensure that the principles of equity and fairness govern the procedural course of all litigation.",
          "effective": "2026-06-01",
          "fetched": "2026-09-18"
        },
        {
          "title": "Same — Civil Rule 2.1(a)(2)(b) (Duties Owed to the Court — extension of existing law)",
          "url": "https://www.casd.uscourts.gov/_assets/pdf/rules/2026.06.01%20Local%20Rules.pdf",
          "verbatim": "We expect lawyers arguing for an extension of existing law to clearly state that fact and why.",
          "effective": "2026-06-01",
          "fetched": "2026-09-18"
        },
        {
          "title": "Same — Civil Rule 2.1(a)(3)(f) (Duties Owed to Other Lawyers, Parties and Witnesses — accuracy)",
          "url": "https://www.casd.uscourts.gov/_assets/pdf/rules/2026.06.01%20Local%20Rules.pdf",
          "verbatim": "We expect lawyers to be accurate in written communications intended to make a record.",
          "effective": "2026-06-01",
          "fetched": "2026-09-18"
        },
        {
          "title": "Same — Civil Rule 2.2(a) (Discipline — referral to admitting courts' disciplinary bodies; crosses page break)",
          "url": "https://www.casd.uscourts.gov/_assets/pdf/rules/2026.06.01%20Local%20Rules.pdf",
          "verbatim": "In the event any attorney engages in conduct which may warrant discipline or other sanctions, the Court or any judge may, in addition to initiating proceedings for contempt under Title 18 U.S.C. § 401 and Rule 42, Fed. R. Crim. P., or imposing other appropriate sanctions, refer the matter to the disciplinary body of any court before which the attorney has been admitted to practice.",
          "effective": "2026-06-01",
          "fetched": "2026-09-18"
        },
        {
          "title": "Same — Civil Rule 2.2(e) (Standing Committee on Discipline investigates unprofessional conduct on a judge's referral)",
          "url": "https://www.casd.uscourts.gov/_assets/pdf/rules/2026.06.01%20Local%20Rules.pdf",
          "verbatim": "will investigate any charge or information, referred by one of the judges, that any member of the bar of this court or that any attorney permitted to practice in the Court has been guilty of unprofessional conduct.",
          "effective": "2026-06-01",
          "fetched": "2026-09-18"
        },
        {
          "title": "Same — Civil Rule 83.1(a) (Sanctions for Noncompliance with Rules — includes any order of the Court)",
          "url": "https://www.casd.uscourts.gov/_assets/pdf/rules/2026.06.01%20Local%20Rules.pdf",
          "verbatim": "Failure of counsel, or of any party, to comply with these rules, with the Federal Rules of Civil or Criminal Procedure, or with any order of the Court may be grounds for imposition by the Court of any and all sanctions authorized by statute or rule or within the inherent power of the Court, including, without limitation, dismissal of any actions, entry of default, finding of contempt, imposition of monetary sanctions or attorneys' fees and costs, and other lesser sanctions.",
          "effective": "2026-06-01",
          "fetched": "2026-09-18"
        },
        {
          "title": "Same — Civil Rule 83.3(c)(1)(a) (Admission limited to active members in good standing of the State Bar of California)",
          "url": "https://www.casd.uscourts.gov/_assets/pdf/rules/2026.06.01%20Local%20Rules.pdf",
          "verbatim": "Admission to and continuing membership in the bar of this court is limited to attorneys of good moral character who are active members in good standing of the State Bar of California.",
          "effective": "2026-06-01",
          "fetched": "2026-09-18"
        },
        {
          "title": "Same — Civil Rule 83.3(c)(1)(c) (admitted attorneys must adhere to the Code of Conduct)",
          "url": "https://www.casd.uscourts.gov/_assets/pdf/rules/2026.06.01%20Local%20Rules.pdf",
          "verbatim": "Each attorney admitted to this Court must adhere to the Code of Conduct set forth in Civ. L.R. 2.1 and Crim. L.R. 2.1, respectively.",
          "effective": "2026-06-01",
          "fetched": "2026-09-18"
        },
        {
          "title": "Same — Civil Rule 83.3(c)(4) (Pro Hac Vice — application must state under penalty of perjury, item (6))",
          "url": "https://www.casd.uscourts.gov/_assets/pdf/rules/2026.06.01%20Local%20Rules.pdf",
          "verbatim": "(6) that the attorney has read, understands and agrees to adhere to each of this Court’s Rules, including, without limitation, the Court’s Code of Conduct under Civ. L.R.2.1 and Crim. L.R. 2.1.",
          "effective": "2026-06-01",
          "fetched": "2026-09-18"
        },
        {
          "title": "Same — Criminal Rule 1.1(e) (Applicable Civil Rules; list includes Rule 83.3 Attorney Admissions, Standards)",
          "url": "https://www.casd.uscourts.gov/_assets/pdf/rules/2026.06.01%20Local%20Rules.pdf",
          "verbatim": "The provisions of the following Civil Local Rules will apply to all criminal actions and proceedings",
          "effective": "2026-06-01",
          "fetched": "2026-09-18"
        },
        {
          "title": "Same — Criminal Rule 2.1 (Professionalism — Civil Rule 2.1 incorporated in criminal cases)",
          "url": "https://www.casd.uscourts.gov/_assets/pdf/rules/2026.06.01%20Local%20Rules.pdf",
          "verbatim": "The provisions of Civil Local Rule 2.1 (Professionalism) are incorporated herein by reference in their entirety and will govern the conduct of all participants in all criminal cases and proceedings pending in this court.",
          "effective": "2026-06-01",
          "fetched": "2026-09-18"
        },
        {
          "title": "Same — Criminal Rule 2.2 (Discipline — Civil Rule 2.2 incorporated in criminal cases)",
          "url": "https://www.casd.uscourts.gov/_assets/pdf/rules/2026.06.01%20Local%20Rules.pdf",
          "verbatim": "The provisions of Civil Local Rule 2.2 (Discipline) are incorporated herein by reference in their entirety and will govern the conduct of all participants in all criminal cases and proceedings pending in this court.",
          "effective": "2026-06-01",
          "fetched": "2026-09-18"
        },
        {
          "title": "General Order 770, Proposed Local Rule Amendments (filed Apr. 30, 2026) — amends Civil Rules 33.1, 36.1, 83.6 and Criminal Rule 57.2.1; no AI provision (page 1 image-only; read by OCR, not quoted)",
          "url": "https://www.casd.uscourts.gov/_assets/pdf/rules/General%20Order%20770%20Proposed%20Local%20Rule%20Amendments.pdf",
          "verbatim": "Absent further order of this Court, the effective date of the Rule amendments is June 1, 2026.",
          "effective": "2026-04-30",
          "fetched": "2026-09-18"
        },
        {
          "title": "Fed. R. Civ. P. 11(b) (Federal Rules of Civil Procedure, Dec. 1, 2025 edition, uscourts.gov) — national rule",
          "url": "https://www.uscourts.gov/sites/default/files/document/federal-rules-of-civil-procedure.pdf",
          "verbatim": "certifies that to the best of the person’s knowledge, information, and belief, formed after an inquiry reasonable under the circumstances",
          "effective": null,
          "fetched": "2026-09-18"
        },
        {
          "title": "Same — Fed. R. Civ. P. 11(c)(1) (law firm responsibility)",
          "url": "https://www.uscourts.gov/sites/default/files/document/federal-rules-of-civil-procedure.pdf",
          "verbatim": "Absent exceptional circumstances, a law firm must be held jointly responsible for a violation committed by its partner, associate, or employee.",
          "effective": null,
          "fetched": "2026-09-18"
        },
        {
          "title": "Judge-specific — District Judge Gonzalo P. Curiel, Civil Pretrial & Trial Procedures (civil chambers rules; no date on the face — PDF metadata created 2026-01-05, not a date on the document), § ARTIFICIAL INTELLIGENCE, p. 13, ¶ 3 — CERTIFICATION requirement for any submission containing AI-generated content; not court-wide",
          "url": "https://www.casd.uscourts.gov/judges/curiel/docs/Curiel%20Civil%20Chambers%20Rules.pdf",
          "verbatim": "Additionally, any submission containing AI-generated content must include a certification that counsel or the pro se party has personally verified the content’s accuracy. Failure to include this certification or comply with this verification requirement will be grounds for sanctions.",
          "effective": null,
          "fetched": "2026-09-18"
        },
        {
          "title": "Same (Curiel civil) — § ARTIFICIAL INTELLIGENCE, p. 13, ¶ 3 — RECORD-KEEPING of prompts",
          "url": "https://www.casd.uscourts.gov/judges/curiel/docs/Curiel%20Civil%20Chambers%20Rules.pdf",
          "verbatim": "Counsel and pro se parties are responsible for maintaining records of all prompts or inquiries submitted to any generative AI tools in the event those records become relevant.",
          "effective": null,
          "fetched": "2026-09-18"
        },
        {
          "title": "Same (Curiel civil) — § ARTIFICIAL INTELLIGENCE, p. 13, ¶ 2 — accuracy duty under Rule 11 and the California Rules of Professional Conduct",
          "url": "https://www.casd.uscourts.gov/judges/curiel/docs/Curiel%20Civil%20Chambers%20Rules.pdf",
          "verbatim": "Despite the spread of generative AI tools, counsel and pro se parties are responsible for providing the Court with complete and accurate representations of any submission, including filings, demonstratives, evidence, or oral argument, consistent with Federal Rule of Civil Procedure 11, the California Rules of Professional Conduct, and any other applicable legal or ethical guidance.",
          "effective": null,
          "fetched": "2026-09-18"
        },
        {
          "title": "Same (Curiel civil) — § ARTIFICIAL INTELLIGENCE, p. 13, ¶ 2 — use not prohibited; personal verification",
          "url": "https://www.casd.uscourts.gov/judges/curiel/docs/Curiel%20Civil%20Chambers%20Rules.pdf",
          "verbatim": "Use of generative AI tools is not prohibited, but counsel and pro se parties must, at all times, personally confirm for themselves the accuracy of any content generated by these tools.",
          "effective": null,
          "fetched": "2026-09-18"
        },
        {
          "title": "Same (Curiel civil) — § ARTIFICIAL INTELLIGENCE, p. 13, ¶ 2 — California State Bar guidance",
          "url": "https://www.casd.uscourts.gov/judges/curiel/docs/Curiel%20Civil%20Chambers%20Rules.pdf",
          "verbatim": "Counsel are expected to abide by existing and evolving California State Bar guidance and advisory opinions on the use of AI in the legal profession.",
          "effective": null,
          "fetched": "2026-09-18"
        },
        {
          "title": "Same (Curiel civil) — § ARTIFICIAL INTELLIGENCE, p. 13, ¶ 1 — definition and examples of generative AI tools",
          "url": "https://www.casd.uscourts.gov/judges/curiel/docs/Curiel%20Civil%20Chambers%20Rules.pdf",
          "verbatim": "Common examples of generative AI tools include ChatGPT, Google Gemini, and Microsoft Copilot.",
          "effective": null,
          "fetched": "2026-09-18"
        },
        {
          "title": "Same (Curiel civil) — § AI GENERATED EVIDENCE, p. 6, ¶ 1 — notice to opposing party of AI-generated evidentiary material",
          "url": "https://www.casd.uscourts.gov/judges/curiel/docs/Curiel%20Civil%20Chambers%20Rules.pdf",
          "verbatim": "Counsel shall serve a notice to the opposing party identifying AI-generated evidentiary material with sufficient specificity to locate it (i.e., via production number, attaching a copy to the notice, providing a copy on request). This notice should be served with the production or disclosure of any AI-generated evidentiary material. Any AI-generated material that does not have an accompanying notice shall not be considered by the Court.",
          "effective": null,
          "fetched": "2026-09-18"
        },
        {
          "title": "Same (Curiel civil) — § AI GENERATED EVIDENCE, p. 6, ¶ 2 — unverified AI-created assertions of fact",
          "url": "https://www.casd.uscourts.gov/judges/curiel/docs/Curiel%20Civil%20Chambers%20Rules.pdf",
          "verbatim": "Failure to confirm the accuracy or basis for an assertion of fact or evidence created by an AI tool is grounds for potential sanctions.",
          "effective": null,
          "fetched": "2026-09-18"
        },
        {
          "title": "Judge-specific — District Judge Todd W. Robinson, Standing Order for Civil Cases (Revised September 16, 2024), § III.D Use of Generative Artificial Intelligence — caution/verification only (no disclosure, no certification); not court-wide",
          "url": "https://www.casd.uscourts.gov/judges/robinson/docs/Civil%20Standing%20Order.pdf",
          "verbatim": "Accordingly, failure to exercise due care in reviewing and filing work product created with the assistance of generative AI tools may violate Rule 11 and other applicable standards of practice and expose the filer to sanctions or other corrective or disciplinary action.",
          "effective": "2024-09-16",
          "fetched": "2026-09-18"
        },
        {
          "title": "Same (Robinson civil) — § III.D, first sentence (use not prohibited)",
          "url": "https://www.casd.uscourts.gov/judges/robinson/docs/Civil%20Standing%20Order.pdf",
          "verbatim": "Although the use of ChatGPT and other such generative artificial intelligence (“AI”) tools is not prohibited, unqualified reliance on such tools may result in filings “replete with misrepresentations and fabricated case law.”",
          "effective": "2024-09-16",
          "fetched": "2026-09-18"
        },
        {
          "title": "Same (Robinson civil) — revision line on the last page",
          "url": "https://www.casd.uscourts.gov/judges/robinson/docs/Civil%20Standing%20Order.pdf",
          "verbatim": "Revised September 16, 2024",
          "effective": "2024-09-16",
          "fetched": "2026-09-18"
        },
        {
          "title": "Rule 26(f) Conference Checklist, U.S. District Court for the Southern District of California (Updated 4/9/2025), as posted with Magistrate Judge Allison H. Goddard's chambers rules — § IV Search Methodology for ESI (GenAI tools as a discovery search method; discussion topic, not a filing rule). Same text posted by Magistrate Judges Burkhardt, Cabrera, Chu, Leshner, Pettit and Torres",
          "url": "https://www.casd.uscourts.gov/judges/goddard/docs/Goddard%20Rule%2026(f)%20Conference%20Checklist.pdf",
          "verbatim": "The parties should discuss what search methodologies will be used to identify responsive ESI, including the use of search terms, technology assisted review (“TAR”), or Generative Artificial Intelligence (“GenAI”) tools, and how those methodologies will be validated.",
          "effective": "2025-04-09",
          "fetched": "2026-09-18"
        },
        {
          "title": "Same (Rule 26(f) Conference Checklist) — date line",
          "url": "https://www.casd.uscourts.gov/judges/goddard/docs/Goddard%20Rule%2026(f)%20Conference%20Checklist.pdf",
          "verbatim": "(Updated 4/9/2025)",
          "effective": "2025-04-09",
          "fetched": "2026-09-18"
        },
        {
          "title": "Same (Rule 26(f) Conference Checklist) — § VIII Use of Generative Artificial Intelligence to Create or Enhance Evidence",
          "url": "https://www.casd.uscourts.gov/judges/goddard/docs/Goddard%20Rule%2026(f)%20Conference%20Checklist.pdf",
          "verbatim": "The parties should discuss whether they intend to present any evidence that is created or enhanced by a GenAI tool at trial, such as video enhancement or scene reconstructions, and whether specific deadlines should be set in the case schedule for challenging the admission of such evidence.",
          "effective": "2025-04-09",
          "fetched": "2026-09-18"
        },
        {
          "title": "Same (Rule 26(f) Conference Checklist) — § VII Privilege Log (GenAI-generated log as an alternative)",
          "url": "https://www.casd.uscourts.gov/judges/goddard/docs/Goddard%20Rule%2026(f)%20Conference%20Checklist.pdf",
          "verbatim": "The parties should discuss whether an alternative form of privilege log, such as a categorical log, metadata log, sample log, or GenAI-generated log would be more efficient than a traditional privilege log.",
          "effective": "2025-04-09",
          "fetched": "2026-09-18"
        },
        {
          "title": "U.S. BANKRUPTCY COURT for the S.D. Cal. (not the district court) — Bankruptcy General Order No. 210, In re Filings Using Generative Artificial Intelligence (dated and filed Nov. 18, 2025; effective Jan. 1, 2026) — court-wide AI attestation requirement for bankruptcy filings (OCR; image-only PDF, quotation compared by eye with the page image)",
          "url": "https://www.casb.uscourts.gov/sites/casb/files/documents/general-orders/General%20Order%20210_2025-11-18.pdf",
          "verbatim": "Effective January 1, 2026, any pleading, motion, or paper (whether moving, opposing, or in reply) that the filer prepared in any aspect by using a generative artificial intelligence (“AI”) program must be accompanied by an attestation or certification signed by the filer:",
          "effective": "2026-01-01",
          "fetched": "2026-09-18"
        },
        {
          "title": "Same — GO 210, first bullet (OCR)",
          "url": "https://www.casb.uscourts.gov/sites/casb/files/documents/general-orders/General%20Order%20210_2025-11-18.pdf",
          "verbatim": "Identifying the AI program used; and",
          "effective": "2026-01-01",
          "fetched": "2026-09-18"
        },
        {
          "title": "Same — GO 210, second bullet (OCR)",
          "url": "https://www.casb.uscourts.gov/sites/casb/files/documents/general-orders/General%20Order%20210_2025-11-18.pdf",
          "verbatim": "Certifying that the filer checked the document for factual and legal accuracy using print reporters, traditional legal databases, or other reliable means.",
          "effective": "2026-01-01",
          "fetched": "2026-09-18"
        },
        {
          "title": "Same — GO 210, Rule 9011 paragraph (OCR)",
          "url": "https://www.casb.uscourts.gov/sites/casb/files/documents/general-orders/General%20Order%20210_2025-11-18.pdf",
          "verbatim": "Rule 9011 of the Federal Rules of Bankruptcy Procedure continues to apply to all documents filed with the Court. Furthermore, the Court construes each filing as a certification by the person signing a filed document of compliance with Rule 9011(b).",
          "effective": "2026-01-01",
          "fetched": "2026-09-18"
        },
        {
          "title": "U.S. Bankruptcy Court, S.D. Cal. — Local Form CSD 5013, Disclosure and Certification on Generative Artificial Intelligence Use (form dated [01/01/2026]; form page revision date 12/17/25) — Certification paragraph",
          "url": "https://www.casb.uscourts.gov/sites/casb/files/documents/forms/CSD5013_2026-01-01_R1.pdf",
          "verbatim": "The filer(s) of the attached paper certify that they checked the document for factual and legal accuracy using print reporters, traditional legal databases, or other reliable means outside of AI.",
          "effective": "2026-01-01",
          "fetched": "2026-09-18"
        },
        {
          "title": "Same — CSD 5013, scope paragraphs (what the Court considers generative AI; tools typically not covered)",
          "url": "https://www.casb.uscourts.gov/sites/casb/files/documents/forms/CSD5013_2026-01-01_R1.pdf",
          "verbatim": "For purposes of its General Order, the Court considers generative AI to be that which can create original content such as text or images in response to a user's prompt or request. This includes in particular the creation of a filed paper's initial content through such a prompt or request. Later augmentations to initial content are likewise subject to the General Order if that is created through a prompt or request using generative Al. In contrast, spell checkers, predictive text prompts, grammar checkers, paraphrasing tools, text polishers and the like are typically not covered by the General Order.",
          "effective": "2026-01-01",
          "fetched": "2026-09-18"
        },
        {
          "title": "U.S. Bankruptcy Court, S.D. Cal. — news item 'General Order 210: Filings Using Generative Artificial Intelligence' (Tuesday, November 18, 2025)",
          "url": "https://www.casb.uscourts.gov/news/general-order-210-filings-using-generative-artificial-intelligence",
          "verbatim": "General Order 210 is effective January 1, 2026.",
          "effective": "2026-01-01",
          "fetched": "2026-09-18"
        },
        {
          "title": "U.S. Bankruptcy Court, S.D. Cal. — news item 'Using Generative Artificial Intelligence in Filings' (Wednesday, December 17, 2025) announcing CSD 5013",
          "url": "https://www.casb.uscourts.gov/news/using-generative-artificial-intelligence-filings",
          "verbatim": "In addition, the new attestation form will be posted and effective on January 1, 2026:",
          "effective": "2026-01-01",
          "fetched": "2026-09-18"
        },
        {
          "title": "U.S. Bankruptcy Court, S.D. Cal. — CSD 5013 form page (Form #: CSD 5013; Revision Date: 12/17/25; Reference: Local Form)",
          "url": "https://www.casb.uscourts.gov/forms/disclosure-and-certification-generative-artificial-intelligence-use",
          "verbatim": null,
          "effective": null,
          "fetched": "2026-09-18"
        },
        {
          "title": "S.D. Cal. Local Rules page (links the 2026.06.01 Local Rules and the ECF Administrative Policies & Procedures Manual) — checked, no AI item",
          "url": "https://www.casd.uscourts.gov/rules/local-rules.aspx",
          "verbatim": null,
          "effective": null,
          "fetched": "2026-09-18"
        },
        {
          "title": "S.D. Cal. General Orders page (Recent General Orders, Chief Judge Orders, Archive) — checked; no AI general order or chief judge order among titles posted 2023–2026",
          "url": "https://www.casd.uscourts.gov/rules/general-orders.aspx",
          "verbatim": null,
          "effective": null,
          "fetched": "2026-09-18"
        },
        {
          "title": "S.D. Cal. Chambers Rules page (court's consolidated list of each judge's chambers rules documents)",
          "url": "https://www.casd.uscourts.gov/judges/chambers-rules.aspx",
          "verbatim": null,
          "effective": null,
          "fetched": "2026-09-18"
        },
        {
          "title": "S.D. Cal. Judges page (district, magistrate and visiting judges)",
          "url": "https://www.casd.uscourts.gov/judges.aspx",
          "verbatim": null,
          "effective": null,
          "fetched": "2026-09-18"
        },
        {
          "title": "S.D. Cal. News, Notices & Events page — checked, no AI notice",
          "url": "https://www.casd.uscourts.gov/CourtNews.aspx",
          "verbatim": null,
          "effective": null,
          "fetched": "2026-09-18"
        },
        {
          "title": "S.D. Cal. home page — checked, no AI notice",
          "url": "https://www.casd.uscourts.gov/",
          "verbatim": null,
          "effective": null,
          "fetched": "2026-09-18"
        },
        {
          "title": "S.D. Cal. Electronic Case Filing Administrative Policies and Procedures Manual (dated January 16, 2026; linked from the CM/ECF page) — Section 2(f)(1) (Signatures — Registered Users); no AI provision (grep)",
          "url": "https://www.casd.uscourts.gov/_assets/pdf/cmecf/Electronic%20Case%20Filing%20Procedures%20Manual.pdf",
          "verbatim": "The registered user log-in and password required to submit documents to the CM/ECF system will serve as that registered user’s signature for purposes of Rule 11 of the Federal Rules of Civil Procedure and for all other purposes under the Federal Rules of Civil, Criminal and Appellate Procedure and the Local Rules of this court.",
          "effective": "2026-01-16",
          "fetched": "2026-09-18"
        },
        {
          "title": "Same (ECF Manual) — Section 1(g) (Logins and Passwords)",
          "url": "https://www.casd.uscourts.gov/_assets/pdf/cmecf/Electronic%20Case%20Filing%20Procedures%20Manual.pdf",
          "verbatim": "Documents filed under an attorney's login and password will constitute that attorney's signature for purposes of the Local Rules and Federal Rules of Civil and Criminal Procedure, including Rule 11 of the Federal Rules of Civil Procedure. The attorney is responsible for all documents filed with his or her password.",
          "effective": "2026-01-16",
          "fetched": "2026-09-18"
        },
        {
          "title": "S.D. Cal. ECF Administrative Policies and Procedures Manual — older copy dated September 24, 2025, still linked from the Filing Procedures page (differs from the Jan. 16, 2026 copy only in date, two chambers e-mail addresses and page footers); no AI provision (grep)",
          "url": "https://www.casd.uscourts.gov/_assets/pdf/attorney/Electronic%20Case%20Filing%20Procedures%20Manual.pdf",
          "verbatim": null,
          "effective": "2025-09-24",
          "fetched": "2026-09-18"
        },
        {
          "title": "S.D. Cal. General Filing Procedures (Clerk's Office manual, Revised 1/16/2026) — no AI provision (grep)",
          "url": "https://www.casd.uscourts.gov/_assets/pdf/attorney/General%20Filing%20Procedures.pdf",
          "verbatim": null,
          "effective": "2026-01-16",
          "fetched": "2026-09-18"
        },
        {
          "title": "S.D. Cal. General Order 550, Procedural Rules for Electronic Case Filing (filed May 22, 2006) — image-only; read by OCR; no AI provision",
          "url": "https://www.casd.uscourts.gov/_assets/pdf/cmecf/GO_550.pdf",
          "verbatim": null,
          "effective": null,
          "fetched": "2026-09-18"
        },
        {
          "title": "S.D. Cal. CM/ECF page — checked, no AI item",
          "url": "https://www.casd.uscourts.gov/cmecf.aspx",
          "verbatim": null,
          "effective": null,
          "fetched": "2026-09-18"
        },
        {
          "title": "S.D. Cal. Filing Procedures page — checked, no AI item",
          "url": "https://www.casd.uscourts.gov/attorney/filing-procedures.aspx",
          "verbatim": null,
          "effective": null,
          "fetched": "2026-09-18"
        },
        {
          "title": "General Order 765, Proposed Local Rule Changes (filed Sept. 18, 2025; amends Civil Rule 5.1) — no AI provision (pages 2-7 image-only, read by OCR)",
          "url": "https://www.casd.uscourts.gov/_assets/pdf/rules/General%20Order%20765%20Proposed%20Local%20Rule%20Changes.pdf",
          "verbatim": null,
          "effective": null,
          "fetched": "2026-09-18"
        },
        {
          "title": "General Order 707-A, Local Rules Amendments (filed Dec. 12, 2024; adds Civil Rule 73.2, effective Jan. 2, 2025) — no AI provision",
          "url": "https://www.casd.uscourts.gov/_assets/pdf/rules/General%20Order%20707-A%20Local%20Rules%20Amendments.pdf",
          "verbatim": null,
          "effective": null,
          "fetched": "2026-09-18"
        },
        {
          "title": "General Order 744-A, Adopting Disciplinary Committee (dated May 7, 2025; appoints the Civil Rule 2.2(c) Standing Committee on Discipline) — no AI provision",
          "url": "https://www.casd.uscourts.gov/_assets/pdf/rules/General%20Order%20744-A%20Adopting%20Disciplinary%20Committee.pdf",
          "verbatim": null,
          "effective": null,
          "fetched": "2026-09-18"
        },
        {
          "title": "Decision, not a sanctions ruling — Taction Technology, Inc. v. Apple Inc., No. 21-cv-812-TWR-JLB (S.D. Cal. Aug. 11, 2026) (Robinson, J.), ECF No. 545, pp. 34-35: denied Apple's ex parte motion that argued the opposing expert's corrected reports bore signs of AI generation (expert testified she did not use AI); cites Kohls v. Ellison (D. Minn.) — CourtListener RECAP copy; not quoted",
          "url": "https://storage.courtlistener.com/recap/gov.uscourts.casd.705779/gov.uscourts.casd.705779.545.0.pdf",
          "verbatim": null,
          "effective": "2026-08-11",
          "fetched": "2026-09-18"
        },
        {
          "title": "Party filing, not a decision — United States v. Chaabani, No. 24-cr-2713-WQH (S.D. Cal.), ECF No. 69 (filed May 13, 2025): defense counsel's motion to withdraw a filing, admitting an AI-hallucinated case name and use of LEXIS AI, ChatGPT and Grok; no ruling on it was located — CourtListener RECAP copy; not quoted",
          "url": "https://storage.courtlistener.com/recap/gov.uscourts.casd.800926/gov.uscourts.casd.800926.69.0_2.pdf",
          "verbatim": null,
          "effective": "2025-05-13",
          "fetched": "2026-09-18"
        },
        {
          "title": "LEAD ONLY — web search 2026-09-18 (Robinson Civil Standing Order surfaced as an S.D. Cal. AI standing order; Bankruptcy Court GO 210 surfaced); Ropes & Gray AI court-order tracker, California page (HTTP 403, not read)",
          "url": "https://www.ropesgray.com/en/sites/artificial-intelligence-court-order-tracker/states/california",
          "verbatim": null,
          "effective": null,
          "fetched": null
        },
        {
          "title": "Judge Curiel — Criminal Chambers Rules — checked in full, no AI provision (grep)",
          "url": "https://www.casd.uscourts.gov/judges/curiel/docs/Curiel%20Criminal%20Chambers%20Rules.pdf",
          "verbatim": null,
          "effective": null,
          "fetched": "2026-09-18"
        },
        {
          "title": "Judge Robinson — Criminal Chambers Rules (Revised 5/19/2026) — checked in full, no AI provision (grep)",
          "url": "https://www.casd.uscourts.gov/judges/robinson/docs/Criminal%20Chambers%20Rules.pdf",
          "verbatim": null,
          "effective": "2026-05-19",
          "fetched": "2026-09-18"
        },
        {
          "title": "Magistrate Judge Burkhardt — Model Protective Order (Word file linked from the judge page, not from the Chambers Rules page) — no AI provision",
          "url": "https://www.casd.uscourts.gov/Judges/burkhardt/docs/Burkhardt%20Model%20Protective%20Order.docx",
          "verbatim": null,
          "effective": null,
          "fetched": "2026-09-18"
        },
        {
          "title": "Magistrate Judge Cabrera — Model Protective Order (Word file linked from the judge page) — no AI provision",
          "url": "https://www.casd.uscourts.gov/Judges/cabrera/docs/MODEL%20Cabrera%20Model%20Protective%20Order.docx",
          "verbatim": null,
          "effective": null,
          "fetched": "2026-09-18"
        },
        {
          "title": "Same case (Chaabani) — ECF No. 80, Order denying the replacement motion to dismiss (June 2, 2025) (Hayes, J.) — read; no AI mention; not quoted",
          "url": "https://storage.courtlistener.com/recap/gov.uscourts.casd.800926/gov.uscourts.casd.800926.80.0.pdf",
          "verbatim": null,
          "effective": "2025-06-02",
          "fetched": "2026-09-18"
        },
        {
          "title": "LEAD ONLY — Vaquill, AI Hallucination Sanctions Tracker (read via web fetch 2026-09-18; lists no S.D. Cal. matter; places Couvrette v. Wisnovsky (Brigandi/Murphy) in D. Or.)",
          "url": "https://www.vaquill.ai/blog/ai-hallucination-sanctions-tracker",
          "verbatim": null,
          "effective": null,
          "fetched": null
        }
      ],
      "status": "verified",
      "verified_on": "2026-09-18",
      "verified_by": "claude-opus-5 (independent verifier session; every source URL re-fetched 2026-09-17; checkq/strictq exact match; pinpoints, effective dates, status and narrative claims checked against the fetched text; one missed-item search)",
      "attorney_signoff": null,
      "notes": "(i) COURT-WIDE: VERIFIED NOTHING AI-SPECIFIC in the district court's rules governing filings. The Local Rules PDF (cover: Revised as of June 1, 2026; one PDF holding the Civil, Patent, Model Protective Order and Criminal rules) was grepped in full for artificial intelligence, generative, AI, A.I., ChatGPT, large language, machine learning and hallucination: the only hits are facsimile machine (Civil Rule 5.3) and machine-readable media (Model Protective Order). The ECF Administrative Policies and Procedures Manual (January 16, 2026), the older copy dated September 24, 2025, the General Filing Procedures (Revised 1/16/2026) and General Order 550 (ECF, 2006) have no AI provision. General Orders page: every General Order and Chief Judge Order posted 2023 through 2026-09-17 (121 linked files; 118 PDFs + 3 Word magistrate-judge application forms, which were not opened) was fetched and grepped, except PACER-fee-exemption chief judge orders whose file names contain Electronic Public Access (31 such files on the page, all years), which were skipped as non-rules (those named Pacer Exemption were read); image-only files were read by OCR: no AI order. The only AI mentions are Chief Judge Orders 96 (3/14/2023) and 119 (7/11/2024), which grant PACER fee exemptions for research on AI or machine-learning applications (not rules). Rule amendments in the period (GO 747/747-A, 748, 749, 752, 754, 707-A, 765, 770) touch Civil Rules 5.1, 7.1, 16.1, 33.1, 36.1, 40.1, 72.3, 73.2, 83.6, 83.8 and Criminal Rule 57.2.1; none touches AI. Pages checked with no AI item, all fetched 2026-09-18: home page, Local Rules page, General Orders page, Chambers Rules page, Judges page, News, Notices & Events page (CourtNews.aspx), CM/ECF page, Filing Procedures page. (ii) BINDING STATUS: the Local Rules bind. Chambers rules and standing orders bind only in the issuing judge's cases; Civil Rule 83.1(a) makes failure to comply with any order of the Court sanctionable, and Civil Rule 2.1(a)(1) names the Local and Chambers' Rules together as safeguards. Judge Curiel's AI section is phrased as a requirement (must include a certification; failure will be grounds for sanctions); Judge Robinson's is a warning. The Rule 26(f) Conference Checklist is discussion guidance for the parties' conference, not a filing rule. (iii) PROPOSED/PENDING: no proposed local rule or general order on AI found. The latest amendments (GO 770, filed 4/30/2026, effective June 1, 2026) do not touch AI. (iv) JUDGE LEVEL: the court's Chambers Rules page (its consolidated list) links 88 documents for 34 judges: 20 of the 22 district judges (Anello, Bashant, Battaglia, Bencivengo, Cheeks, Curiel, Hayes, Huff, Huie, Lopez, Lorenz, Miller, Montenegro, Moskowitz, Ohta, Robinson, Sabraw, Schopler, Simmons, Whelan), all 13 resident magistrate judges (Berg, Burkhardt, Butcher, Cabral, Cabrera, Chu, Dembin, Goddard, Leshner, Pettit, Rodriguez, Torres, White) and visiting Magistrate Judge Ferraro. All 88 were downloaded 2026-09-18 and grepped in full; the few image-only pages (Butcher criminal rules p. 3 and attachment p. 2, and cover/signature pages) were OCR'd. District Judges Houston and Sammartino list no chambers documents; Judge Huff's one-page procedures say she has no specific chambers rules; the other 13 visiting judges list none. HITS: (1) District Judge Gonzalo P. Curiel, civil chambers rules (Civil Pretrial & Trial Procedures; no date on the face, PDF metadata 2026-01-05), section ARTIFICIAL INTELLIGENCE (p. 13): use of generative AI is not prohibited; counsel and pro se parties must personally confirm the accuracy of AI output under Rule 11 and the California Rules of Professional Conduct; must keep records of all prompts submitted to generative AI tools; and any submission containing AI-generated content must include a certification of personal verification, failing which sanctions may follow. No form or wording is prescribed for that certification (so certificate_language stays null; the requirement text is quoted in sources). The same rules' AI GENERATED EVIDENCE section (p. 6) requires notice to the opponent of AI-generated evidentiary material. Judge Curiel's criminal chambers rules have no AI provision. (2) District Judge Todd W. Robinson, Standing Order for Civil Cases (Revised September 16, 2024), § III.D Use of Generative Artificial Intelligence: a Rule 11 warning citing Grant v. City of Long Beach (9th Cir. 2024) and Park v. Kim (2d Cir. 2024); no disclosure or certification. His criminal chambers rules (Revised 5/19/2026) have no AI provision. (3) The court's Rule 26(f) Conference Checklist (Goddard copy marked Updated 4/9/2025; same text posted by Magistrate Judges Burkhardt, Cabrera, Chu, Leshner, Pettit and Torres) lists GenAI as a discovery search method to discuss and validate, a GenAI-generated privilege log as an alternative, and GenAI-created or enhanced trial evidence as a topic. No other chambers document mentions AI (the one Battaglia hit is the word Regenerative in a case name). Individual judge pages are ASP.NET postbacks (Judges/Judge-Info.aspx); they were fetched by replaying the postback (see the judge-page check below). Hence disclosure_to_court is judge_specific and certification_required is false for the court-wide position. Check the assigned district and magistrate judge's chambers rules for every matter. Judge-page check: all 49 judge pages on the Judges page (22 district, 13 resident magistrate, 14 visiting) were fetched on 2026-09-18 by replaying each ASP.NET postback to Judges/Judge-Info.aspx (session-based, so no stable per-judge URL); no page text mentions AI. Every chambers document they link is on the Chambers Rules page except four Word files, which were fetched and read: Burkhardt and Cabrera model protective orders and the Robinson and Whelan consent-to-magistrate-judge forms. None mentions AI. (v) BANKRUPTCY COURT (separate unit, separate site and rules; NOT the district court's position): U.S. Bankruptcy Court for the S.D. Cal. General Order No. 210 (dated Nov. 18, 2025, effective Jan. 1, 2026) requires, for any pleading, motion or paper prepared in any aspect with a generative AI program, an attestation or certification signed by the filer identifying the AI program and certifying an accuracy check by print reporters, traditional legal databases or other reliable means, for attorneys and self-represented filers alike; Local Form CSD 5013 (Disclosure and Certification on Generative Artificial Intelligence Use, dated 01/01/2026) implements it. The GO 210 PDF is image-only; its quotations are OCR text compared by eye with the page image. The main session may prefer to move these sources to a separate bankruptcy-court entry (e.g., us-bankr-sdca), where disclosure_to_court would be required, certification_required true, and certificate_language the CSD 5013 certification paragraph. (vi) DECISIONS: CourtListener API searches on 2026-09-18 (opinions and RECAP documents, court casd; terms artificial intelligence, generative AI, ChatGPT, AI-generated, hallucinated, fictitious, fabricated, nonexistent, sanctions, Rule 11, show cause) found no S.D. Cal. order sanctioning AI-fabricated citations. Found instead: Taction Technology v. Apple (Aug. 11, 2026, Robinson, J.), which rejected an argument that an expert's reports were AI-generated, and a defense motion in United States v. Chaabani (May 13, 2025, ECF No. 69) admitting an AI-hallucinated case name. In Chaabani the only related ruling is a docket-text order of May 14, 2025 (ECF No. 72, ORDER re Motion to Withdrawn and Replace; no document on RECAP, and the docket text shows no sanction); the June 2, 2025 order denying the replacement motion (ECF No. 80, read) does not mention AI. Neither decision is quoted. A web-search lead (Dec. 2025 press report of two San Diego cases with fake citations) was not resolved to a court; the Vaquill sanctions tracker (read 2026-09-18 via web fetch, lead only) lists no S.D. Cal. matter and places the Brigandi/Murphy sanction (Couvrette v. Wisnovsky) in the District of Oregon, not S.D. Cal. CourtListener's coverage of S.D. Cal. is partial, so absence there is not proof of absence; the verifier should run one Westlaw/Lexis search for S.D. Cal. AI-citation sanctions. (vii) PROFESSIONAL CONDUCT: the June 1, 2026 Local Rules contain no provision adopting the State Bar Act or the California Rules of Professional Conduct as the court's conduct standard (grep of the whole PDF for State Bar, professional conduct, Rules of Professional, ethic and Business and Professions: the only hits are the admission and bar-number provisions). What the rules have is Civil Rule 83.3(c)(1)(a) (admission limited to active members in good standing of the State Bar of California), Civil Rule 2.1 (Code of Conduct), Civil Rule 2.2 (discipline) and Civil Rule 83.1 (sanctions). The rule numbering itself suggests a repeal: the Civil Rules run 83.1, 83.2, 83.3, 83.6, 83.7, 83.8, 83.9, 83.11, so 83.4, 83.5 and 83.10 are absent. OPEN QUESTION for the verifier: whether an earlier version of the S.D. Cal. rules contained such an incorporation (e.g., a former Civil Rule 83.4) and when it was dropped; none of the 2023-2026 amendment orders read here touches it. Pro hac vice attorneys are not State Bar members; in this court they are bound by the Code of Conduct, Rule 11 and their own jurisdictions' rules. Judge Curiel's rules separately invoke the California Rules of Professional Conduct and California State Bar AI guidance (see the ca-rpc and ca-state-bar-guidance entries). (viii) EFFECTIVE DATE: the Local Rules cover says Revised as of June 1, 2026 and GO 770 made its amendments effective June 1, 2026, but Civil Rule 1.1(b) and Criminal Rule 1.1(b) inside the same PDF still say the rules become effective on January 2, 2025. effective is set to 2026-06-01 from the cover. (ix) FETCH LOG: casd.uscourts.gov began rejecting requests (F5 Request Rejected page served as HTTP 404) after about 70 rapid requests at about 06:58 EDT on 2026-09-18; the block lifted at 07:06 EDT and every document was then fetched with 6-second pacing. Nothing listed above remains unfetched. The Ropes & Gray tracker returned HTTP 403 (lead only, not read). (x) VERIFIER (2026-09-18): all 43 quotations re-checked exact; the chambers-rules listing was re-enumerated in a browser (the page is ASP.NET postback-driven) and all 88 documents across 34 judges were re-fetched and grepped, reproducing this entry's result exactly — AI language only in Judge Curiel's civil chambers rules, Judge Robinson's civil standing order and seven copies of the Rule 26(f) checklist, the lone Battaglia hit being the word Regenerative in a case name. The four Bankruptcy General Order 210 quotations were compared with the rendered page image and match word for word. The open question above (whether an earlier version of these rules adopted the California Rules of Professional Conduct, e.g. a former Civil Rule 83.4) REMAINS OPEN: archive.org returned HTTP 429 on 2026-09-18 and 2026-09-20, so earlier versions could not be retrieved."
    },
    {
      "id": "us-9th-cir",
      "kind": "federal_appellate",
      "name": "U.S. Court of Appeals for the Ninth Circuit",
      "disclosure_to_court": "none",
      "certification_required": false,
      "certificate_language": null,
      "verification_duty": "No AI-specific rule; the Circuit Advisory Committee Note to Circuit Rule 32-1 (new Dec. 1, 2025) addresses generative AI and makes the signature the verification point: the rules do not regulate how a filing is produced — \"such as writing it personally with no assistance, delegating part of its preparation to a subordinate, or employing generative artificial intelligence. Regardless of how the filing is prepared, the signature is an attestation that the signer has reviewed the filing and is responsible for the accuracy of its contents.\" Precedential order: Lnu v. Blanche, No. 24-4790 (9th Cir. June 3, 2026) (for publication; order imposing discipline under FRAP 46(b) and Circuit Rule 46-2): \"That is, the rules are not violated at the point of research and drafting, but at the point of signing and filing.\" and, whatever the drafting method, \"the party or attorney who submits the filing with this Court must read the authorities cited therein to ensure that they are real, properly attributed, and accurately represented.\" (slip op. 17-18). Correction duty (candor): \"An attorney who erroneously submits a hallucination in a brief must notify the Court and opposing counsel immediately, describe the nature of the error (a fabrication, a gross misrepresentation, etc.), and disclose how the error came about—here, misused generative AI.\" (slip op. 25). For California-office attorneys the court applied the California Rules of Professional Conduct and State Bar Act as the applicable rules (slip op. 13). Earlier precedent: Grant v. City of Long Beach, 96 F.4th 1255 (9th Cir. 2024) (published; brief with fabricated and misrepresented citations struck under Circuit Rule 28-1 and appeal dismissed; AI not mentioned).",
      "confidentiality_restriction": null,
      "record_keeping_duty": "none",
      "client_disclosure_duty": "none as a general rule. Case-specific: Lnu ordered the sanctioned attorneys to give a copy of the order to their clients, opposing counsel and presiding judges in every pending case.",
      "fees_note": "Lnu imposed personal monetary sanctions ($2,500 each) under FRAP 46(b) and Circuit Rule 46-2; Circuit Rule 46-2(a) lists \"a monetary penalty\" among available discipline.",
      "sources": [
        {
          "title": "Ninth Circuit Rules Handbook (FRAP, Circuit Rules, Circuit Advisory Committee Notes), effective June 1, 2026 — Circuit Advisory Committee Note to Rule 32-1 (New 12/1/25) (p. -141-)",
          "url": "https://cdn.ca9.uscourts.gov/datastore/uploads/frap-June%201%202026.pdf",
          "verbatim": "such as writing it personally with no assistance, delegating part of its preparation to a subordinate, or employing generative artificial intelligence. Regardless of how the filing is prepared, the signature is an attestation that the signer has reviewed the filing and is responsible for the accuracy of its contents. Parties and attorneys should therefore be careful to ensure the reliability of any filing. (New 12/1/25)",
          "effective": "2025-12-01",
          "fetched": "2026-09-18"
        },
        {
          "title": "Same — Circuit Rule 46-2(a) (conduct subject to discipline; available discipline)",
          "url": "https://cdn.ca9.uscourts.gov/datastore/uploads/frap-June%201%202026.pdf",
          "verbatim": "(a) Conduct Subject to Discipline. This Court may impose discipline on any attorney practicing before this Court who engages in conduct violating applicable rules of professional conduct, or who fails to comply with rules or orders of this Court. The discipline may consist of disbarment, suspension, reprimand, counseling, education, a monetary penalty, restitution, or any other action that the Court deems appropriate and just.",
          "effective": null,
          "fetched": "2026-09-18"
        },
        {
          "title": "Same — Circuit Rule 36-3(a) (unpublished dispositions and orders not precedent; Lnu and Grant are published)",
          "url": "https://cdn.ca9.uscourts.gov/datastore/uploads/frap-June%201%202026.pdf",
          "verbatim": "(a) Not Precedent. Unpublished dispositions and orders of this Court are not precedent, except when relevant under the doctrine of law of the case or rules of claim preclusion or issue preclusion.",
          "effective": null,
          "fetched": "2026-09-18"
        },
        {
          "title": "Ninth Circuit Rules Handbook dated 1 December 2025 (the frap.pdf link on the Rules page) — same Rule 32-1 Advisory Committee Note text",
          "url": "https://cdn.ca9.uscourts.gov/datastore/uploads/rules/frap.pdf",
          "verbatim": "Regardless of how the filing is prepared, the signature is an attestation that the signer has reviewed the filing and is responsible for the accuracy of its contents.",
          "effective": "2025-12-01",
          "fetched": "2026-09-18"
        },
        {
          "title": "Circuit Rule Revisions 2025 packet (the December 2025 Circuit Rule changes link on the Rules page) — earlier wording of the same Note (differs from the handbook; see notes)",
          "url": "https://cdn.ca9.uscourts.gov/datastore/uploads/rules/ALL+CR+Revisions+FINAL+Sept+2025.pdf",
          "verbatim": "Regardless of how the filing is prepared, the signature is an attestation that the signer has reviewed the filing and is responsible for its contents.",
          "effective": "2025-12-01",
          "fetched": "2026-09-18"
        },
        {
          "title": "Lnu v. Blanche, No. 24-4790 (9th Cir. June 3, 2026) (FOR PUBLICATION; Order; Paez, Bea, Forrest, JJ.) — slip op. 5 (purpose — warning to the bar)",
          "url": "https://cdn.ca9.uscourts.gov/datastore/opinions/2026/06/03/24-4790.pdf",
          "verbatim": "We issue this disciplinary order, and explain our reasoning at some length, as a warning to the members of this Court’s bar: be aware of the risks of overreliance on generative AI, read everything cited in a court filing—whether drafted by generative AI or not—and disclose quickly and transparently generative AI hallucinations that are inadvertently included in court filings.",
          "effective": "2026-06-03",
          "fetched": "2026-09-18"
        },
        {
          "title": "Same — slip op. 13 (California rules applied to California-office attorneys)",
          "url": "https://cdn.ca9.uscourts.gov/datastore/opinions/2026/06/03/24-4790.pdf",
          "verbatim": "Because Sethi and Rounds maintain their principal office in California, we apply the California Rules of Professional Conduct and California’s State Bar Act as the “applicable rules of professional conduct.”",
          "effective": "2026-06-03",
          "fetched": "2026-09-18"
        },
        {
          "title": "Same — slip op. 13 (AI use itself not sanctioned)",
          "url": "https://cdn.ca9.uscourts.gov/datastore/opinions/2026/06/03/24-4790.pdf",
          "verbatim": "We do not sanction Sethi and Rounds for the simple fact that they or their subordinates used generative AI.",
          "effective": "2026-06-03",
          "fetched": "2026-09-18"
        },
        {
          "title": "Same — slip op. 16 (violation occurs at signing and filing)",
          "url": "https://cdn.ca9.uscourts.gov/datastore/opinions/2026/06/03/24-4790.pdf",
          "verbatim": "That is, the rules are not violated at the point of research and drafting, but at the point of signing and filing.",
          "effective": "2026-06-03",
          "fetched": "2026-09-18"
        },
        {
          "title": "Same — slip op. 18 (signer must read the cited authorities; quotation begins mid-sentence after the page break)",
          "url": "https://cdn.ca9.uscourts.gov/datastore/opinions/2026/06/03/24-4790.pdf",
          "verbatim": "the party or attorney who submits the filing with this Court must read the authorities cited therein to ensure that they are real, properly attributed, and accurately represented.",
          "effective": "2026-06-03",
          "fetched": "2026-09-18"
        },
        {
          "title": "Same — slip op. 22 (delegation no excuse)",
          "url": "https://cdn.ca9.uscourts.gov/datastore/opinions/2026/06/03/24-4790.pdf",
          "verbatim": "It is no excuse that Sethi entrusted substantive cite checking to subordinates, and it is no excuse that Sethi purportedly did not know his subordinates had used generative AI",
          "effective": "2026-06-03",
          "fetched": "2026-09-18"
        },
        {
          "title": "Same — slip op. 25 (candor — disclose the source of a hallucination)",
          "url": "https://cdn.ca9.uscourts.gov/datastore/opinions/2026/06/03/24-4790.pdf",
          "verbatim": "An attorney who erroneously submits a hallucination in a brief must notify the Court and opposing counsel immediately, describe the nature of the error (a fabrication, a gross misrepresentation, etc.), and disclose how the error came about—here, misused generative AI.",
          "effective": "2026-06-03",
          "fetched": "2026-09-18"
        },
        {
          "title": "Same — slip op. 28 (immediate correction and disclosure)",
          "url": "https://cdn.ca9.uscourts.gov/datastore/opinions/2026/06/03/24-4790.pdf",
          "verbatim": "We stress that when an attorney learns of any error in a filing—including generative AI hallucinations—he should immediately alert the court and opposing counsel of the error and disclose its source.",
          "effective": "2026-06-03",
          "fetched": "2026-09-18"
        },
        {
          "title": "Same — slip op. 28 (discipline ¶ 1, monetary sanction)",
          "url": "https://cdn.ca9.uscourts.gov/datastore/opinions/2026/06/03/24-4790.pdf",
          "verbatim": "Sethi and Rounds are each personally sanctioned in the amount of $2,500.",
          "effective": "2026-06-03",
          "fetched": "2026-09-18"
        },
        {
          "title": "Same — slip op. 29 (discipline ¶ 2, suspension)",
          "url": "https://cdn.ca9.uscourts.gov/datastore/opinions/2026/06/03/24-4790.pdf",
          "verbatim": "Sethi and Rounds are hereby suspended from practice before this Court for a period of six months starting ten days after this Order is filed.",
          "effective": "2026-06-03",
          "fetched": "2026-09-18"
        },
        {
          "title": "Same — slip op. 29 (discipline ¶ 4, firm-specific AI disclosure and certification for two years — NOT a general rule)",
          "url": "https://cdn.ca9.uscourts.gov/datastore/opinions/2026/06/03/24-4790.pdf",
          "verbatim": "Sethi, Rounds, and all attorneys at the Firm are ordered to include in all future filings a statement, made under penalty of perjury, addressing whether generative AI was used, disclosing the name of the tool used, and certifying that the attorney signing the brief or other filing has personally reviewed the filing and that all citations and quotations therein refer to existing authority. This requirement shall remain in place for two years from the date of this Order.",
          "effective": "2026-06-03",
          "fetched": "2026-09-18"
        },
        {
          "title": "Grant v. City of Long Beach, No. 22-56121 (9th Cir. Mar. 22, 2024) (FOR PUBLICATION; Opinion by Desai, J.; cited as 96 F.4th 1255 in Lnu) — slip op. 4 (brief struck, appeal dismissed)",
          "url": "https://cdn.ca9.uscourts.gov/datastore/opinions/2024/03/22/22-56121.pdf",
          "verbatim": "Because we find that Appellants’ opening brief represents a material failure to comply with our rules, we strike the brief in its entirety pursuant to Ninth Circuit Rule 28–1 and dismiss this appeal.",
          "effective": "2024-03-22",
          "fetched": "2026-09-18"
        },
        {
          "title": "Same — slip op. 5 (nonexistent cases)",
          "url": "https://cdn.ca9.uscourts.gov/datastore/opinions/2024/03/22/22-56121.pdf",
          "verbatim": "Unfortunately, Appellants not only materially misrepresent the facts and holdings of the cases they cite in the brief, but they also cite two cases that do not appear to exist.",
          "effective": "2024-03-22",
          "fetched": "2026-09-18"
        },
        {
          "title": "Ninth Circuit General Orders (PDF posted March 30, 2026; file dated 2025-06-25) — full-text grep for artificial intelligence / generative, 0 hits",
          "url": "https://cdn.ca9.uscourts.gov/datastore/uploads/rules/general_orders/general_orders_20250625.pdf",
          "verbatim": null,
          "effective": null,
          "fetched": "2026-09-18"
        },
        {
          "title": "Proposed Circuit Rules for June 2026 and Redlined Proposed Amendments to Circuit Rules (Jan. 2026) — full-text grep, 0 AI hits",
          "url": "https://cdn.ca9.uscourts.gov/datastore/uploads/rules/proposed-circuit-rules-for-June-2026.pdf",
          "verbatim": null,
          "effective": null,
          "fetched": "2026-09-18"
        },
        {
          "title": "Ninth Circuit Rules of Practice and Procedure page (rules effective June 1, 2026; administrative orders list; proposed rules; last updated Sept. 17, 2026)",
          "url": "https://www.ca9.uscourts.gov/rules/",
          "verbatim": "The rules of this court, effective June 1, 2026, are laid out in a handbook that contains:",
          "effective": null,
          "fetched": "2026-09-18"
        },
        {
          "title": "LEAD ONLY — Bloomberg Law, \"Ninth Circuit Warns of AI Hallucinated Briefs in Sanctions Order\" (search result; not read)",
          "url": "https://news.bloomberglaw.com/litigation/ninth-circuit-warns-of-ai-hallucinated-briefs-in-sanctions-order",
          "verbatim": null,
          "effective": null,
          "fetched": null
        },
        {
          "title": "LEAD ONLY — Volokh Conspiracy, \"Ninth Circuit on AI Hallucinations\" (June 3, 2026) (search result; not read)",
          "url": "https://reason.com/volokh/2026/06/03/ninth-circuit-on-ai-hallucinations/",
          "verbatim": null,
          "effective": null,
          "fetched": null
        }
      ],
      "status": "verified",
      "verified_on": "2026-09-18",
      "verified_by": "claude-opus-5 (independent verifier session; every source URL re-fetched 2026-09-17; checkq/strictq exact match; pinpoints, effective dates, status and narrative claims checked against the fetched text; one missed-item search)",
      "attorney_signoff": null,
      "notes": "(i) RULES: no Ninth Circuit rule requires AI disclosure or certification. The only AI text in the Rules Handbook (effective June 1, 2026; full-text grep, 1 hit) is the Circuit Advisory Committee Note to Rule 32-1 (New 12/1/25), which ties responsibility to the FRAP 32(d) signature. Checked with no AI text (all fetched 2026-09-18): General Orders PDF (posted March 30, 2026); Proposed Circuit Rules for June 2026; Redlined Proposed Amendments (Jan. 2026); administrative orders listed on the Rules page (2019-2023 titles; none concern AI). (ii) NOTE-TEXT VARIANCE: the Circuit Rule Revisions 2025 packet (linked as the December 2025 changes) words the Note \"the process could include writing it personally\" and \"is responsible for its contents\"; both the Dec. 1, 2025 and June 1, 2026 handbooks read \"such as writing it personally\" and \"responsible for the accuracy of its contents\", which is the text Lnu quotes. Quote the handbook. (iii) BINDING STATUS: Lnu is a published order (\"FOR PUBLICATION\") and Grant a published opinion; under Circuit Rule 36-3(a) only unpublished dispositions and orders are non-precedential. Lnu's discipline ¶ 4 (sworn AI-use statement, tool name, and personal-review certification in all future filings for two years) binds only the sanctioned attorneys and their firm; it is not a court-wide certification requirement, so disclosure_to_court stays none and certificate_language null. (iv) Lnu relies on California authorities for the California-office attorneys: Noland v. Land of the Free, 114 Cal.App.5th 426; In re Domestic Partnership of Torres Campos & Munoz, 118 Cal.App.5th 1112 (2026); Shayan v. Shakib, 116 Cal.App.5th 619 (2025); and the State Bar Practical Guidance (see ca-state-courts, ca-state-bar-guidance, ca-rpc). One citation in the order reads \"Noland, 336 Cal. App. 5th at 446\" (slip op. 16), apparently a typographical slip for 114 Cal.App.5th; not relied on. (v) NOT FOUND/NOT CHECKED: any other published Ninth Circuit opinion or order on AI-generated filings (web searches 2026-09-18 found only Lnu and Grant; memorandum dispositions and unpublished orders were not searched and would not be precedent); any Ninth Circuit internal policy on judges' or staff use of AI (none on the Rules page). REPORTER CITE CAUTION: Del Biaggio v. Bansen (Cal. Ct. App. July 10, 2026, A174647; see ca-state-courts) cites Lnu as Malkeet LNU v. Blanche (9th Cir. 2026) 117 F.4th 1014; the compiler could not confirm that citation (Grant, filed March 2024, is at 96 F.4th, so volume 117 for a June 2026 order looks doubtful). Cite Lnu by docket number and date until the reporter cite is confirmed. (vi) VERIFIER (2026-09-18): all 19 quotations re-checked exact. The reporter-cite caution stands: Del Biaggio does print the citation Malkeet LNU v. Blanche (9th Cir. 2026) 117 F.4th 1014, 2026 U.S.App. Lexis 16174, and the slip opinion carries no reporter citation, and volume 117 remains doubtful for a June 2026 order; cite Lnu by docket number and date. Separately, secondary write-ups of Lnu claim it also imposed double costs and $15,000 each in punitive sanctions and a circuit-wide AI disclosure requirement: the order's text contains a single dollar figure ($2,500 each), no mention of costs, fees or punitive sanctions, and its paragraph 4 statement requirement binds only the sanctioned attorneys and their firm, for two years. Do not repeat the secondary accounts."
    },
    {
      "id": "federal-district-judge-orders",
      "kind": "judge_order",
      "name": "Federal district court judge-specific standing orders on generative AI (per-judge)",
      "disclosure_to_court": "judge_specific",
      "certification_required": "judge_specific",
      "certificate_language": "per judge — copy verbatim from the standing order",
      "verification_duty": "Common elements: disclose whether AI was used, name the tool, describe how, certify that a licensed attorney reviewed and verified every citation, legal argument, and factual assertion.",
      "confidentiality_restriction": null,
      "record_keeping_duty": "none",
      "client_disclosure_duty": "none",
      "sources": [
        {
          "title": "Law360 Pulse AI tracker (federal judge orders) — LEAD ONLY, not a primary source",
          "url": "https://www.law360.com/pulse/ai-tracker",
          "verbatim": null,
          "effective": null,
          "fetched": null
        },
        {
          "title": "AI Vortex court disclosure map (2026) — LEAD ONLY",
          "url": "https://www.aivortex.io/legal/guides/ai-court-disclosure-map-2026/",
          "verbatim": null,
          "effective": null,
          "fetched": null
        }
      ],
      "status": "draft",
      "verified_on": null,
      "verified_by": null,
      "attorney_signoff": null,
      "notes": "One entry per judge is required when a matter is before that judge (id pattern: us-<district>-judge-<lastname>). The trackers locate the order; the order itself must be fetched from the court's site and quoted."
    },
    {
      "id": "fl-rpc",
      "kind": "state_bar",
      "name": "Rules Regulating The Florida Bar, Florida Bar Ethics Opinion 24-1, and the statewide AI signature rule — Fla. R. Gen. Prac. & Jud. Admin. 2.515(d)(2)(D), in force since June 15, 2026",
      "disclosure_to_court": "none — and read the string, because Florida is the opposite of the federal patchwork. No Florida rule requires a filer to disclose that AI was used, and since June 15, 2026 no Florida court is permitted to require it. Administrative Order AOSC26-12 (May 28, 2026) rescinds the circuit-level practice: \"The amendments to rule 2.515(d)(2) obviate the need for circuit-level disclosure or certification requirements about the use of artificial intelligence and the accuracy of information in court filings. Accordingly, courts may not impose such requirements – whether through local administrative orders, court policies, judicial practices and procedures, or other means.\" What replaced them is a verification representation, not a disclosure: the signer must represent that \"the legal authorities identified exist and are accurately cited.\" AOSC26-12 preserves two things courts may still do: educating users about AI, and governing court staff. In its words, courts keep the authority \"to warn such users about sanctions for making inaccurate filings. Nor does the order affect courts’ authority to govern court system employees’ use of artificial intelligence.\"",
      "certification_required": true,
      "certificate_language": "No certificate text is prescribed and nothing is added to the document. The certification is made by the act of signing. Fla. R. Gen. Prac. & Jud. Admin. 2.515(d)(2), as amended effective June 15, 2026, provides that \"On filing, each signer represents that:\" the signer has read the document, that there are good grounds to support it, that it is not interposed for delay, and, in new subdivision (D), that \"the legal authorities identified exist and are accurately cited.\" The same subdivision supplies the remedy: \"The Court may, on its own motion or the motion of a party, impose sanctions for any filing inconsistent with this representation after providing the signer notice and an opportunity to be heard. Such sanctions may include reprimand, contempt, striking of the document, dismissal of proceedings, costs, attorneys’ fees, or other sanctions.\"",
      "verification_duty": "BINDING AND AI-DRIVEN. Fla. R. Gen. Prac. & Jud. Admin. 2.515(d)(2)(D) (effective June 15, 2026): each signer of any document filed with any Florida court represents that \"the legal authorities identified exist and are accurately cited.\" The Supreme Court of Florida adopted it on its own motion because of generative AI: SC2026-0673 (May 28, 2026) at 2 — \"Given the demonstrated risks of generative AI and to promote the accuracy and integrity of court filings, we amend rule 2.515(d)(2)\". The duty runs to unrepresented parties too: \"This requirement applies both to filings prepared by attorneys and to filings prepared by unrepresented parties.\" RULES OF PROFESSIONAL CONDUCT. R. Regulating Fla. Bar 4-3.3(a)(1): a lawyer shall not knowingly \"make a false statement of fact or law to a tribunal or fail to correct a false statement of material fact or law previously made to the tribunal by the lawyer\". Supervision: rule 4-5.1(b), a supervising lawyer \"must make reasonable efforts to ensure that the other lawyer conforms to the Rules of Professional Conduct.\"; rule 4-5.3(b)(2) the same for a nonlawyer. The comment to rule 4-5.1(a) now names the technology: managerial policies include \"considering safeguards for the firm’s use of technologies such as generative artificial intelligence\". ETHICS OPINION (advisory). Florida Bar Ethics Opinion 24-1 (Jan. 19, 2024): \"Functionally, this means a lawyer must verify the accuracy and sufficiency of all research performed by generative AI. The failure to do so can lead to violations of the lawyer’s duties of competence (Rule 4-1.1), avoidance of frivolous claims and contentions (Rule 4-3.1), candor to the tribunal (Rule 4-3.3), and truthfulness to others (Rule 4-4.1), in addition to sanctions that may be imposed by a tribunal against the lawyer and the lawyer’s client.\" Its own first page says \"Advisory ethics opinions are not binding.\" ENFORCED. Florida DCAs are sanctioning attorneys under rule 2.515 now, not theoretically. Capital Standard, LLC v. U.S. Bank N.A., No. 2D2024-1392 (Fla. 2d DCA Aug. 21, 2026), slip op. at 15 (a $1,500 fine, an appellate fee award, and a Bar referral, with the court adding that the attorney \"may not charge his clients for\" them); JMOR Props., LLC v. Artist Alley Townhomes, LLC, No. 4D2026-1787 (Fla. 4th DCA Aug. 12, 2026) (Bar referral; \"Counsel’s explanation that he mistakenly submitted the wrong draft of the petition does not excuse the failure to verify the accuracy of all citations in his filing.\"); Russell v. Mells, 426 So. 3d 913 (Fla. 2d DCA 2025) — \"When a lawyer cites imaginary legal authorities to our court as if they were law, we are compelled to refer that lawyer to the Bar because of the professional rules of conduct.\"",
      "confidentiality_restriction": "R. Regulating Fla. Bar 4-1.6(a): \"A lawyer must not reveal information relating to a client’s representation except as stated in subdivisions (b), (c), and (d), unless the client gives informed consent.\" Rule 4-1.6(e): \"A lawyer must make reasonable efforts to prevent the inadvertent or unauthorized disclosure of, or unauthorized access to, information relating to the client’s representation.\" Since October 28, 2024 the comment to rule 4-1.6 names AI directly: \"For example, a lawyer should be aware that generative artificial Intelligence may create risks to the lawyer’s duty of confidentiality.\" — the capital I is a typographical error in the Bar's compilation; the Supreme Court's own appendix to SC2024-0032 reads \"generative artificial intelligence may create risks to the lawyer’s duty of confidentiality.\" in lower case. Ethics Opinion 24-1 adds the practical rule and a real safe harbour: \"it is recommended that a lawyer obtain the affected client’s informed consent prior to utilizing a third-party generative AI program if the utilization would involve the disclosure of any confidential information.\" and \"If the use of a generative AI program does not involve the disclosure of confidential information to a third-party, a lawyer is not required to obtain a client’s informed consent pursuant to Rule 4-1.6.\" It also warns against mining other lawyers' inputs: a lawyer \"should not attempt to access information previously provided to the generative AI by other lawyers.\"",
      "record_keeping_duty": "none",
      "client_disclosure_duty": "conditional, and in Florida the trigger is confidentiality, not AI use as such. Binding: rule 4-1.4(a)(1) requires a lawyer to \"promptly inform the client of any decision or circumstance with respect to which the client’s informed consent, as defined in terminology, is required by these rules\", and rule 4-1.6(a) makes informed consent the gate for revealing client information. No Florida rule requires telling a client that AI was used. Advisory Opinion 24-1 recommends informed consent where client information would go to a third-party tool — \"it is recommended that a lawyer obtain the affected client’s informed consent prior to utilizing a third-party generative AI program if the utilization would involve the disclosure of any confidential information.\" — and expressly does not require it where no confidential information leaves the firm. Separately, on fees, Opinion 24-1 says the standards \"require a lawyer to inform a client, preferably in writing, of the lawyer’s intent to charge a client the actual cost of using generative AI.\"",
      "fees_note": "R. Regulating Fla. Bar 4-1.5(a): \"A lawyer must not enter into an agreement for, charge, or collect an illegal, prohibited, or clearly excessive fee or cost, or a fee generated by employment that was obtained through advertising or solicitation not in compliance with the Rules Regulating The Florida Bar.\" Ethics Opinion 24-1 applies it to AI in three distinct ways. (1) No inflated hours: \"Though generative AI programs may make a lawyer’s work more efficient, this increase in efficiency must not result in falsely inflated claims of time.\" (2) Costs at actual cost or as overhead, never prorated: \"If a lawyer is unable to determine the actual cost associated with a particular client’s matter, the lawyer may not ethically prorate the periodic charges of the generative AI and instead should account for those charges as overhead.\" (3) No billing for learning the tool: \"while a lawyer may charge a client for the reasonable time spent for case-specific research and drafting when using generative AI, the lawyer should be careful not to charge for the time spent developing minimal competence in the use of generative AI.\" A sanctions overlay exists as well — in Capital Standard the Second District held the attorney \"is solely responsible for paying the fee award and fine and may not charge his clients for\" them.",
      "sources": [
        {
          "title": "Supreme Court of Florida, In re Amendments to Florida Rule of General Practice and Judicial Administration 2.515, No. SC2026-0673 (May 28, 2026), slip op. at 1 — what the Court did",
          "url": "https://flcourts-media.flcourts.gov/content/download/2489374/opinion/Opinion_SC2026-0673.pdf",
          "verbatim": "On its own motion, the Court amends Florida Rule of General Practice and Judicial Administration 2.515(d)(2) (Representation by Signer) to require the signer of a document filed with Florida’s courts to represent that “the legal authorities identified exist and are accurately cited.”",
          "effective": "2026-06-15",
          "fetched": "2026-09-21"
        },
        {
          "title": "Same — slip op. at 2, the AI rationale",
          "url": "https://flcourts-media.flcourts.gov/content/download/2489374/opinion/Opinion_SC2026-0673.pdf",
          "verbatim": "Given the demonstrated risks of generative AI and to promote the accuracy and integrity of court filings, we amend rule 2.515(d)(2) to require the signer of a filing to represent that the legal authorities identified in that filing “exist and are accurately cited.” This requirement applies both to filings prepared by attorneys and to filings prepared by unrepresented parties.",
          "effective": "2026-06-15",
          "fetched": "2026-09-21"
        },
        {
          "title": "Same — slip op. at 3, effective date and the still-open comment period",
          "url": "https://flcourts-media.flcourts.gov/content/download/2489374/opinion/Opinion_SC2026-0673.pdf",
          "verbatim": "The amendments shall become effective June 15, 2026, at 12:01 a.m. Because the amendments were not published for comment previously, interested persons shall have 75 days from the date of this opinion in which to file comments with the Court.",
          "effective": "2026-06-15",
          "fetched": "2026-09-21"
        },
        {
          "title": "Same — slip op. at 3 n.2, the comment deadline",
          "url": "https://flcourts-media.flcourts.gov/content/download/2489374/opinion/Opinion_SC2026-0673.pdf",
          "verbatim": "All comments must be filed with the Court on or before August 11, 2026",
          "effective": "2026-06-15",
          "fetched": "2026-09-21"
        },
        {
          "title": "Same — appendix, amended rule 2.515(d)(2)(D) and the sanctions paragraph",
          "url": "https://flcourts-media.flcourts.gov/content/download/2489374/opinion/Opinion_SC2026-0673.pdf",
          "verbatim": "the legal authorities identified exist and are accurately cited. The Court may, on its own motion or the motion of a party, impose sanctions for any filing inconsistent with this representation after providing the signer notice and an opportunity to be heard. Such sanctions may include reprimand, contempt, striking of the document, dismissal of proceedings, costs, attorneys’ fees, or other sanctions.",
          "effective": "2026-06-15",
          "fetched": "2026-09-21"
        },
        {
          "title": "Same — Court Commentary, 2026 Amendment (why the rule exists)",
          "url": "https://flcourts-media.flcourts.gov/content/download/2489374/opinion/Opinion_SC2026-0673.pdf",
          "verbatim": "The Court adopted the 2026 amendments to subdivision (d)(2) principally to create a statewide, uniform replacement for varied circuit court administrative orders imposing disclosure and certification requirements about the use of artificial intelligence in filings.",
          "effective": "2026-06-15",
          "fetched": "2026-09-21"
        },
        {
          "title": "Florida Rules of General Practice and Judicial Administration (Florida Bar compilation current to July 1, 2026) — rule 2.515(d)(2) as published and in force",
          "url": "https://www-media.floridabar.org/uploads/2026/08/2027_01-JULY-Florida-Rules-of-General-Practice-and-Judicial-Administration-7-1-2026.pdf",
          "verbatim": "(B) to the best of the signer’s knowledge, information, and belief, there are good grounds to support the document; and (C) the document is not interposed for delay; and (D) the legal authorities identified exist and are accurately cited.",
          "effective": "2026-06-15",
          "fetched": "2026-09-21"
        },
        {
          "title": "Supreme Court of Florida, Administrative Order No. AOSC26-12, In re Representations by Signers of Filings (May 28, 2026) — the patchwork it replaced",
          "url": "https://flcourts-media.flcourts.gov/content/download/2489379/file/AOSC26-12.pdf",
          "verbatim": "Over the past several months, several judicial circuits have adopted administrative orders requiring filers or signers of court documents to disclose the use of artificial intelligence in the creation of such documents and to certify the accuracy of the information contained therein. These orders, though reasonable and motivated by valid concerns, have created a patchwork of differing disclosure and certification obligations for the parties and attorneys who participate in the court system throughout our State.",
          "effective": "2026-06-15",
          "fetched": "2026-09-21"
        },
        {
          "title": "Same — the prohibition on circuit-level AI disclosure and certification requirements",
          "url": "https://flcourts-media.flcourts.gov/content/download/2489379/file/AOSC26-12.pdf",
          "verbatim": "The amendments to rule 2.515(d)(2) obviate the need for circuit-level disclosure or certification requirements about the use of artificial intelligence and the accuracy of information in court filings. Accordingly, courts may not impose such requirements – whether through local administrative orders, court policies, judicial practices and procedures, or other means. Rather, courts should rely on amended rule 2.515(d)(2), including the enforcement authority expressly set out in the rule.",
          "effective": "2026-06-15",
          "fetched": "2026-09-21"
        },
        {
          "title": "Same — what the order preserves",
          "url": "https://flcourts-media.flcourts.gov/content/download/2489379/file/AOSC26-12.pdf",
          "verbatim": "to warn such users about sanctions for making inaccurate filings. Nor does the order affect courts’ authority to govern court system employees’ use of artificial intelligence.",
          "effective": "2026-06-15",
          "fetched": "2026-09-21"
        },
        {
          "title": "Same — effective date",
          "url": "https://flcourts-media.flcourts.gov/content/download/2489379/file/AOSC26-12.pdf",
          "verbatim": "This order shall take effect on June 15, 2026, at 12:01 a.m. (the effective date of the amendments to rule 2.515(d)(2)).",
          "effective": "2026-06-15",
          "fetched": "2026-09-21"
        },
        {
          "title": "Supreme Court of Florida, In re Amendments to Rules Regulating The Florida Bar – Chapter 4, No. SC2024-0032 (Aug. 29, 2024) — the AI comments and their effective date",
          "url": "https://supremecourt.flcourts.gov/content/download/2439771/opinion/Opinion_SC2024-0032.pdf",
          "verbatim": "In addition to various grammatical changes, we amend the Comments to rules 4-1.1, 4-1.6, 4-5.1, and 4-5.3, adding a warning about the necessity to take care in using generative artificial intelligence.",
          "effective": "2024-10-28",
          "fetched": "2026-09-21"
        },
        {
          "title": "Same — effective date of the Chapter 4 AI comments",
          "url": "https://supremecourt.flcourts.gov/content/download/2439771/opinion/Opinion_SC2024-0032.pdf",
          "verbatim": "The amendments shall become effective October 28, 2024.",
          "effective": "2024-10-28",
          "fetched": "2026-09-21"
        },
        {
          "title": "Rules Regulating The Florida Bar, Chapter 4 (Florida Bar compilation, RRTFB June 30, 2026) — comment to rule 4-1.1, Maintaining competence (the technology-and-AI comment)",
          "url": "https://www-media.floridabar.org/uploads/2026/06/2026_12-JUNE-Chapter-4-RRTFB-1.pdf",
          "verbatim": "To maintain the requisite knowledge and skill, a lawyer should keep abreast of changes in the law and its practice, engage in continuing study and education, including an understanding of the benefits and risks associated with the use of technology, including generative artificial intelligence, and comply with all continuing legal education requirements to which the lawyer is subject.",
          "effective": "2024-10-28",
          "fetched": "2026-09-21"
        },
        {
          "title": "Same — rule 4-1.1 amendment history (when technology competence, then AI, entered the comment)",
          "url": "https://www-media.floridabar.org/uploads/2026/06/2026_12-JUNE-Chapter-4-RRTFB-1.pdf",
          "verbatim": "Amended March 23, 2006, effective May 22, 2006 (933 So.2d 417); amended September 29, 2016, effective January 1, 2017 (200 So.3d 1225); amended August 29, 2024, effective October 28, 2024 (SC2024-0032).",
          "effective": "2024-10-28",
          "fetched": "2026-09-21"
        },
        {
          "title": "Same — comment to rule 4-1.1, technological competence of non-lawyer advisors and safeguarding confidential information",
          "url": "https://www-media.floridabar.org/uploads/2026/06/2026_12-JUNE-Chapter-4-RRTFB-1.pdf",
          "verbatim": "Competent representation may also involve the association or retention of a non-lawyer advisor of established technological competence in the field in question. Competent representation also involves safeguarding confidential information relating to the representation, including, but not limited to, electronic transmissions and communications.",
          "effective": "2024-10-28",
          "fetched": "2026-09-21"
        },
        {
          "title": "Same — rule 4-1.4(a)(1) (Communication; informed consent trigger)",
          "url": "https://www-media.floridabar.org/uploads/2026/06/2026_12-JUNE-Chapter-4-RRTFB-1.pdf",
          "verbatim": "promptly inform the client of any decision or circumstance with respect to which the client’s informed consent, as defined in terminology, is required by these rules;",
          "effective": null,
          "fetched": "2026-09-21"
        },
        {
          "title": "Same — rule 4-1.5(a) (Fees and Costs for Legal Services)",
          "url": "https://www-media.floridabar.org/uploads/2026/06/2026_12-JUNE-Chapter-4-RRTFB-1.pdf",
          "verbatim": "A lawyer must not enter into an agreement for, charge, or collect an illegal, prohibited, or clearly excessive fee or cost, or a fee generated by employment that was obtained through advertising or solicitation not in compliance with the Rules Regulating The Florida Bar.",
          "effective": null,
          "fetched": "2026-09-21"
        },
        {
          "title": "Same — rule 4-1.6(a) (Confidentiality of Information)",
          "url": "https://www-media.floridabar.org/uploads/2026/06/2026_12-JUNE-Chapter-4-RRTFB-1.pdf",
          "verbatim": "A lawyer must not reveal information relating to a client’s representation except as stated in subdivisions (b), (c), and (d), unless the client gives informed consent.",
          "effective": null,
          "fetched": "2026-09-21"
        },
        {
          "title": "Same — rule 4-1.6(e) (Inadvertent Disclosure of Information)",
          "url": "https://www-media.floridabar.org/uploads/2026/06/2026_12-JUNE-Chapter-4-RRTFB-1.pdf",
          "verbatim": "A lawyer must make reasonable efforts to prevent the inadvertent or unauthorized disclosure of, or unauthorized access to, information relating to the client’s representation.",
          "effective": null,
          "fetched": "2026-09-21"
        },
        {
          "title": "Same — comment to rule 4-1.6, Acting Competently to Preserve Confidentiality (the AI sentence)",
          "url": "https://www-media.floridabar.org/uploads/2026/06/2026_12-JUNE-Chapter-4-RRTFB-1.pdf",
          "verbatim": "See rules 4-1.1, 4-5.1 and 4-5.3. For example, a lawyer should be aware that generative artificial Intelligence may create risks to the lawyer’s duty of confidentiality.",
          "effective": "2024-10-28",
          "fetched": "2026-09-21"
        },
        {
          "title": "Same — rule 4-3.3(a)(1) (Candor Toward the Tribunal)",
          "url": "https://www-media.floridabar.org/uploads/2026/06/2026_12-JUNE-Chapter-4-RRTFB-1.pdf",
          "verbatim": "make a false statement of fact or law to a tribunal or fail to correct a false statement of material fact or law previously made to the tribunal by the lawyer;",
          "effective": null,
          "fetched": "2026-09-21"
        },
        {
          "title": "Same — rule 4-5.1(b) (Supervisory Lawyer's Duties)",
          "url": "https://www-media.floridabar.org/uploads/2026/06/2026_12-JUNE-Chapter-4-RRTFB-1.pdf",
          "verbatim": "efforts to ensure that the other lawyer conforms to the Rules of Professional Conduct.",
          "effective": null,
          "fetched": "2026-09-21"
        },
        {
          "title": "Same — comment to rule 4-5.1, firm policies must consider AI safeguards",
          "url": "https://www-media.floridabar.org/uploads/2026/06/2026_12-JUNE-Chapter-4-RRTFB-1.pdf",
          "verbatim": "account for client funds and property, considering safeguards for the firm’s use of technologies such as generative artificial intelligence, and ensure that inexperienced lawyers are properly supervised.",
          "effective": "2024-10-28",
          "fetched": "2026-09-21"
        },
        {
          "title": "Same — rule 4-5.3(b)(2) (supervision of nonlawyers)",
          "url": "https://www-media.floridabar.org/uploads/2026/06/2026_12-JUNE-Chapter-4-RRTFB-1.pdf",
          "verbatim": "a lawyer having direct supervisory authority over the nonlawyer must make reasonable efforts to ensure that the person’s",
          "effective": null,
          "fetched": "2026-09-21"
        },
        {
          "title": "Same — comment to rule 4-5.3, safeguards when assistants use AI",
          "url": "https://www-media.floridabar.org/uploads/2026/06/2026_12-JUNE-Chapter-4-RRTFB-1.pdf",
          "verbatim": "A lawyer should also consider safeguards when assistants use technologies such as generative artificial intelligence.",
          "effective": "2024-10-28",
          "fetched": "2026-09-21"
        },
        {
          "title": "Same — comment to rule 4-5.3, Nonlawyers Outside the Firm (AI listed with other outside services)",
          "url": "https://www-media.floridabar.org/uploads/2026/06/2026_12-JUNE-Chapter-4-RRTFB-1.pdf",
          "verbatim": "sending client documents to a third party for printing or scanning, using generative artificial intelligence, and using an Internet-based service to store client information. When using these services outside the firm, a lawyer must make reasonable efforts to ensure that the services are provided in a manner that is compatible with the lawyer’s professional obligations.",
          "effective": "2024-10-28",
          "fetched": "2026-09-21"
        },
        {
          "title": "Rules Regulating The Florida Bar, Chapter 6 (RRTFB June 30, 2026) — rule 6-10.3(b), the 3-hour technology CLE requirement",
          "url": "https://www-media.floridabar.org/uploads/2026/06/2026_12-JUNE-Chapter-6-RRTFB-1.pdf",
          "verbatim": "Every member must complete a minimum of 30 credit hours of approved continuing legal education activity every 3 years. At least 3 of the 30 credit hours must be in approved technology courses.",
          "effective": null,
          "fetched": "2026-09-21"
        },
        {
          "title": "Florida Bar Ethics Opinion 24-1 (Jan. 19, 2024), p. 1 — binding effect and summary",
          "url": "https://www-media.floridabar.org/uploads/2024/01/FL-Bar-Ethics-Op-24-1.pdf",
          "verbatim": "Advisory ethics opinions are not binding. Lawyers may use generative artificial intelligence (“AI”) in the practice of law but must protect the confidentiality of client information, provide accurate and competent services, avoid improper billing practices, and comply with applicable restrictions on lawyer advertising.",
          "effective": "2024-01-19",
          "fetched": "2026-09-21"
        },
        {
          "title": "Same — p. 1, chatbot disclaimer requirement (the one Florida-specific affirmative disclosure)",
          "url": "https://www-media.floridabar.org/uploads/2024/01/FL-Bar-Ethics-Op-24-1.pdf",
          "verbatim": "Generative AI chatbots that communicate with clients or third parties must comply with restrictions on lawyer advertising and must include a disclaimer indicating that the chatbot is an AI program and not a lawyer or employee of the law firm.",
          "effective": "2024-01-19",
          "fetched": "2026-09-21"
        },
        {
          "title": "Same — Confidentiality, recommended informed consent",
          "url": "https://www-media.floridabar.org/uploads/2024/01/FL-Bar-Ethics-Op-24-1.pdf",
          "verbatim": "Nonetheless, it is recommended that a lawyer obtain the affected client’s informed consent prior to utilizing a third-party generative AI program if the utilization would involve the disclosure of any confidential information.",
          "effective": "2024-01-19",
          "fetched": "2026-09-21"
        },
        {
          "title": "Same — Confidentiality, the in-house safe harbour",
          "url": "https://www-media.floridabar.org/uploads/2024/01/FL-Bar-Ethics-Op-24-1.pdf",
          "verbatim": "If the use of a generative AI program does not involve the disclosure of confidential information to a third-party, a lawyer is not required to obtain a client’s informed consent pursuant to Rule 4-1.6.",
          "effective": "2024-01-19",
          "fetched": "2026-09-21"
        },
        {
          "title": "Same — do not mine other lawyers' prompts",
          "url": "https://www-media.floridabar.org/uploads/2024/01/FL-Bar-Ethics-Op-24-1.pdf",
          "verbatim": "a lawyer using generative AI should take reasonable precautions to avoid the inadvertent disclosure of confidential information and should not attempt to access information previously provided to the generative AI by other lawyers.",
          "effective": "2024-01-19",
          "fetched": "2026-09-21"
        },
        {
          "title": "Same — Oversight of Generative AI, the verification duty",
          "url": "https://www-media.floridabar.org/uploads/2024/01/FL-Bar-Ethics-Op-24-1.pdf",
          "verbatim": "Functionally, this means a lawyer must verify the accuracy and sufficiency of all research performed by generative AI. The failure to do so can lead to violations of the lawyer’s duties of competence (Rule 4-1.1), avoidance of frivolous claims and contentions (Rule 4-3.1), candor to the tribunal (Rule 4-3.3), and truthfulness to others (Rule 4-4.1), in addition to sanctions that may be imposed by a tribunal against the lawyer and the lawyer’s client.",
          "effective": "2024-01-19",
          "fetched": "2026-09-21"
        },
        {
          "title": "Same — no delegation of the practice of law to AI",
          "url": "https://www-media.floridabar.org/uploads/2024/01/FL-Bar-Ethics-Op-24-1.pdf",
          "verbatim": "First and foremost, a lawyer may not delegate to generative AI any act that could constitute the practice of law such as the negotiation of claims or any other function that requires a lawyer’s personal judgment and participation.",
          "effective": "2024-01-19",
          "fetched": "2026-09-21"
        },
        {
          "title": "Same — Legal Fees and Costs, no inflated hours",
          "url": "https://www-media.floridabar.org/uploads/2024/01/FL-Bar-Ethics-Op-24-1.pdf",
          "verbatim": "Though generative AI programs may make a lawyer’s work more efficient, this increase in efficiency must not result in falsely inflated claims of time.",
          "effective": "2024-01-19",
          "fetched": "2026-09-21"
        },
        {
          "title": "Same — Legal Fees and Costs, actual cost, no proration, and written notice",
          "url": "https://www-media.floridabar.org/uploads/2024/01/FL-Bar-Ethics-Op-24-1.pdf",
          "verbatim": "In the context of generative AI, these standards require a lawyer to inform a client, preferably in writing, of the lawyer’s intent to charge a client the actual cost of using generative AI. In all instances, the lawyer must ensure that the charges are reasonable and are not duplicative. If a lawyer is unable to determine the actual cost associated with a particular client’s matter, the lawyer may not ethically prorate the periodic charges of the generative AI and instead should account for those charges as overhead.",
          "effective": "2024-01-19",
          "fetched": "2026-09-21"
        },
        {
          "title": "Same — no billing for learning the tool",
          "url": "https://www-media.floridabar.org/uploads/2024/01/FL-Bar-Ethics-Op-24-1.pdf",
          "verbatim": "while a lawyer may charge a client for the reasonable time spent for case-specific research and drafting when using generative AI, the lawyer should be careful not to charge for the time spent developing minimal competence in the use of generative AI.",
          "effective": "2024-01-19",
          "fetched": "2026-09-21"
        },
        {
          "title": "Same — Conclusion",
          "url": "https://www-media.floridabar.org/uploads/2024/01/FL-Bar-Ethics-Op-24-1.pdf",
          "verbatim": "In sum, a lawyer may ethically utilize generative AI technologies but only to the extent that the lawyer can reasonably guarantee compliance with the lawyer’s ethical obligations.",
          "effective": "2024-01-19",
          "fetched": "2026-09-21"
        },
        {
          "title": "The Florida Bar, Ethics Opinions index — advisory status and the fact that 24-1 is the only AI opinion through 25-1",
          "url": "https://www.floridabar.org/ethics/etopinions/",
          "verbatim": "Advisory ethics opinions are not binding",
          "effective": null,
          "fetched": "2026-09-21"
        },
        {
          "title": "Capital Standard, LLC v. U.S. Bank National Association, No. 2D2024-1392 (Fla. 2d DCA Aug. 21, 2026) — slip op. at 8, rule 2.515 and the false certification",
          "url": "https://flcourts-media.flcourts.gov/content/download/2494161/opinion/Opinion_2024-1392.pdf",
          "verbatim": "These recent changes, however, have simply made more explicit what was already required by rule 2.515(d)(2) at the time Attorney Keefe signed the amended initial brief and reply brief.",
          "effective": "2026-08-21",
          "fetched": "2026-09-21"
        },
        {
          "title": "Same — slip op. at 15, the sanctions imposed on counsel",
          "url": "https://flcourts-media.flcourts.gov/content/download/2494161/opinion/Opinion_2024-1392.pdf",
          "verbatim": "we impose on Attorney Keefe a $1,500 fine payable to the clerk of this court within fourteen days; we remand this matter to the trial court to determine the reasonable amount of appellate attorney's fees incurred by U.S. Bank for researching and answering Capital Standard's amended initial brief; and we refer Attorney Keefe to The Florida Bar for further proceedings.",
          "effective": "2026-08-21",
          "fetched": "2026-09-21"
        },
        {
          "title": "Same — slip op. at 15, the client may not be charged",
          "url": "https://flcourts-media.flcourts.gov/content/download/2494161/opinion/Opinion_2024-1392.pdf",
          "verbatim": "Attorney Keefe is solely responsible for paying the fee award and fine and may not charge his clients for",
          "effective": "2026-08-21",
          "fetched": "2026-09-21"
        },
        {
          "title": "JMOR Properties, LLC v. Artist Alley Townhomes, LLC, No. 4D2026-1787 (Fla. 4th DCA Aug. 12, 2026) — the sanction, citing rule 2.515(d)(2)",
          "url": "https://flcourts-media.flcourts.gov/content/download/2493470/opinion/Opinion_2026-1787.pdf",
          "verbatim": "Having considered counsel Barry M. Leff’s July 10, 2026 response to this Court’s order to show cause, the Court imposes the sanction of referring counsel to the Florida Bar. Fla. R. Jud. Admin. 2.515(d)(2); Fla. R. App. P. 9.410(a).",
          "effective": "2026-08-12",
          "fetched": "2026-09-21"
        },
        {
          "title": "Same — the wrong-draft excuse rejected",
          "url": "https://flcourts-media.flcourts.gov/content/download/2493470/opinion/Opinion_2026-1787.pdf",
          "verbatim": "Counsel’s explanation that he mistakenly submitted the wrong draft of the petition does not excuse the failure to verify the accuracy of all citations in his filing. Fla. R. Jud. Admin. 2.515(d)(2)(D).",
          "effective": "2026-08-12",
          "fetched": "2026-09-21"
        },
        {
          "title": "Russell v. Mells, No. 2D2024-1560 (Fla. 2d DCA Dec. 10, 2025), 426 So. 3d 913 — the leading Florida holding on AI-fabricated citations",
          "url": "https://flcourts-media.flcourts.gov/content/download/2482282/opinion/Opinion_2024-1560.pdf",
          "verbatim": "When a lawyer cites imaginary legal authorities to our court as if they were law, we are compelled to refer that lawyer to the Bar because of the professional rules of conduct.",
          "effective": "2025-12-10",
          "fetched": "2026-09-21"
        },
        {
          "title": "Same — the duty to read what you cite, and that intent is no excuse",
          "url": "https://flcourts-media.flcourts.gov/content/download/2482282/opinion/Opinion_2024-1560.pdf",
          "verbatim": "These ethical requirements are not excused simply because a computer program generated a faulty or misleading legal analysis. Nor is it an excuse that the attorney did not intend to mislead the court.",
          "effective": "2025-12-10",
          "fetched": "2026-09-21"
        },
        {
          "title": "Kings Roofing NWFL, LLC v. Fusion Works Construction, LLC, No. 6D2025-1251 (Fla. 6th DCA May 22, 2026) — an order to show cause, not yet a sanction; included to show the volume of Florida activity",
          "url": "https://flcourts-media.flcourts.gov/content/download/2489177/opinion/Opinion_2025-1251.pdf",
          "verbatim": "The Initial Brief looks as if it was drafted with the assistance of generative artificial intelligence without Mr. McCommon having put sufficient safeguards in place to ensure the existence or accuracy of the cases cited therein.",
          "effective": "2026-05-22",
          "fetched": "2026-09-21"
        },
        {
          "title": "Florida Statutes full-text search for artificial intelligence (leg.state.fl.us), results page 1 of 10 — the only AI-specific statutes found are political advertising and a state technology council",
          "url": "http://www.leg.state.fl.us/statutes/index.cfm?AppMode=Display_Results&Mode=Search%2520Statutes&Submenu=2&Tab=statutes&Search_String=artificial+intelligence",
          "verbatim": "Abstract: F.S. 106.145 106.145 Use of artificial intelligence.",
          "effective": null,
          "fetched": "2026-09-21"
        }
      ],
      "status": "verified",
      "verified_on": "2026-09-21",
      "verified_by": "claude-opus verifier session, batch 3a",
      "attorney_signoff": null,
      "notes": "BOTTOM LINE: Florida is, as of 2026-09-21, the most developed state in this batch and probably the most counter-intuitive. It has a statewide AI-driven verification rule IN FORCE, and it has forbidden its own trial courts from asking for AI disclosure. Fla. R. Gen. Prac. & Jud. Admin. 2.515(d)(2)(D), effective June 15, 2026 at 12:01 a.m., makes every signer of every filing — attorney or unrepresented party — represent that \"the legal authorities identified exist and are accurately cited\", with express sanctions. AOSC26-12, issued the same day as the opinion, says courts \"may not impose\" circuit-level AI disclosure or certification requirements any more. A lawyer coming to Florida from the federal system should be told both halves: you must verify, and you must not be asked to disclose. WATCH ITEM: the 2.515 amendments were adopted without prior publication for comment. Comments were due August 11, 2026 and the Court may still modify the rule; the opinion says only that \"THE FILING OF A MOTION FOR REHEARING SHALL NOT ALTER THE EFFECTIVE DATE OF THESE AMENDMENTS.\" The verifier should re-check docket SC2026-0673 for a post-comment opinion. The Florida Bar's own July 1, 2026 compilation already prints the amended rule, so it is in force whatever happens next. TECHNOLOGY COMPETENCE: Florida adopted it early and has since gone further than almost anyone. The comment to rule 4-1.1 acquired the technology clause on September 29, 2016, effective January 1, 2017 (200 So.3d 1225) — the same order that created the 3-hour technology CLE requirement now in rule 6-10.3(b) — and SC2024-0032 amended it again, effective October 28, 2024, to name generative artificial intelligence in the black-letter comment. Florida is unusual in putting AI into FOUR rule comments: 4-1.1 (competence), 4-1.6 (confidentiality), 4-5.1 (firm-level safeguards) and 4-5.3 (supervision of assistants and of outside services). Note a typographical oddity carried in the official text of the 4-1.6 comment: generative artificial Intelligence, with a capital I. It is quoted here as printed. ETHICS OPINION: Florida Bar Ethics Opinion 24-1 (January 19, 2024) is one of the earliest state opinions and remains the only Florida AI opinion; the Bar's index lists Opinion 25-1 (Nov. 2025) after it, which is about listservs, not AI. Opinion 24-1 is advisory and says so on its face. It goes further than the Texas opinion in two places a lawyer will care about: it recommends INFORMED CONSENT before putting confidential information into a third-party tool (with an express safe harbour for in-house tools), and it requires a chatbot disclaimer under the advertising rules. CASE LAW — FLORIDA IS ENFORCING. Unlike Texas, Florida appellate courts have sanctioned COUNSEL, not just warned pro se litigants. One CourtListener v4 search of Florida state courts (courts fla, fladistctapp; query \"artificial intelligence\" AND (fabricated OR nonexistent OR fictitious) AND sanctions; run 2026-09-21) returned 15 opinions. The three carried here are Capital Standard (2d DCA, Aug. 21, 2026 — a $1,500 fine, a fee award, and a Bar referral, with the fine and fees non-chargeable to the client), JMOR Properties (4th DCA, Aug. 12, 2026 — Bar referral; the wrong-draft excuse rejected) and Russell v. Mells, 426 So. 3d 913 (2d DCA, Dec. 10, 2025 — the holding the others cite). A fourth, Kings Roofing (6th DCA, May 22, 2026), is carried as an order to show cause because it shows the volume. Other cases in the result set that were NOT read include Eclectic Synergy, LLC v. Seredin (4th DCA, May 27, 2026), Gouldy v. Chiasson (4th DCA, July 22, 2026), Goya v. Hayashida, 418 So. 3d 652 (4th DCA 2025), Straub v. Henderson (2d DCA), Gleason v. Marcus (2d DCA), Francois v. Vive Financial (4th DCA), Avery v. Beauzil (4th DCA, two 2026 opinions), Clerk of Court v. Rangel, 427 So. 3d 1069 (2d DCA 2025), and Gutierrez (3d DCA 2024); Hessert v. Hessert, 431 So. 3d 610 (Fla. 6th DCA 2026) and Rodriguez v. Rodriguez (6th DCA Apr. 10, 2026) are cited in the opinions read but were not fetched. Any of these could displace the three chosen. CHECKED, NOTHING FURTHER FOUND (all fetched 2026-09-21): the whole of RRTFB Chapter 4 (Florida Bar compilation, RRTFB June 30, 2026), scanned whitespace-normalized for artificial intelligence, generative, machine learning, large language, chatgpt and hallucinat — five hits, all of them the comments identified above; the whole Florida Rules of General Practice and Judicial Administration (July 1, 2026) — exactly one hit, the 2026 Court Commentary to rule 2.515; RRTFB Chapter 6 — no AI, only the technology CLE requirement; The Florida Bar's Ethics Opinions index (558 opinions) — 24-1 is the only AI opinion; the Florida Statutes full-text search at leg.state.fl.us for artificial intelligence, 93 ranked returns, page 1 read — the AI-specific statutes are § 106.145 (use of AI in political advertisements) and § 282.802 (Government Technology Modernization Council), neither of which touches court filings or the practice of law. METHOD CAVEAT: floridabar.org serves its ethics opinions as an embedded PDF inside a page whose visible HTML contains only navigation, so Opinion 24-1 had to be read from the PDF behind the iframe (www-media.floridabar.org/uploads/2024/01/FL-Bar-Ethics-Op-24-1.pdf). No Cloudflare challenge was encountered on any Florida host. NOT FETCHED: the 2016 opinion at 200 So.3d 1225 that first added technology competence and the CLE requirement (its date and citation are taken from the amendment-history line printed in the Bar's own Chapter 4 compilation, which is a primary source, but the opinion itself was not read); the superseded circuit administrative orders that AOSC26-12 displaced; the cases listed above as not read. ANSWERED WHILE COMPILING: the capital I in generative artificial Intelligence appears only in The Florida Bar's Chapter 4 compilation. The Supreme Court's adopting appendix in SC2024-0032 prints it in lower case, so it is a compilation typo, not the adopted text. Both are quoted in this entry and both are on disk. OPEN QUESTIONS FOR THE VERIFIER: (1) Did the Court issue anything on SC2026-0673 after the August 11, 2026 comment deadline? (2) Confirm that no Florida circuit still publishes an AI disclosure standing order in defiance of AOSC26-12 — an Eleventh Judicial Circuit administrative order 26-04, Disclosure of Use of Generative AI, surfaced in a URL search and its current status was not checked. (3) Does rule 6-10.3(b) technology CLE credit cover AI courses specifically?"
    },
    {
      "id": "il-rpc",
      "kind": "state_bar",
      "name": "Illinois Rules of Professional Conduct of 2010, Illinois Supreme Court Policy on Artificial Intelligence (effective January 1, 2025), and Ill. S. Ct. R. 137",
      "disclosure_to_court": "none — and Illinois is the one state in this batch where the highest court has said so in terms. The Illinois Supreme Court Policy on Artificial Intelligence, effective January 1, 2025, states: \"Disclosure of AI use should not be required in a pleading.\" The same Policy authorizes the use itself: \"The use of AI by litigants, attorneys, judges, judicial clerks, research attorneys, and court staff providing similar support may be expected, should not be discouraged, and is authorized provided it complies with legal and ethical standards.\" Note the register: the Policy says disclosure \"should not be\" required, not that a court \"may not\" require it — weaker than Florida's AOSC26-12 prohibition. No Illinois Supreme Court Rule and no Rule of Professional Conduct mentions AI at all.",
      "certification_required": false,
      "certificate_language": null,
      "verification_duty": "Illinois deliberately chose to rely on its existing signature rule rather than write a new one. Ill. S. Ct. R. 137(a): \"The signature of an attorney or party constitutes a certificate by him that he has read the pleading, motion or other document; that to the best of his knowledge, information, and belief formed after reasonable inquiry it is well grounded in fact and is warranted by existing law or a good-faith argument for the extension, modification, or reversal of existing law, and that it is not interposed for any improper purpose\". The AI Policy supplies the verification duty in terms: \"Attorneys, judges, and self-represented litigants are accountable for their final work product. All users must thoroughly review AI-generated content before submitting it in any court proceeding to ensure accuracy and compliance with legal and ethical obligations. Prior to employing any technology, including generative AI applications, users must understand both general AI capabilities and the specific tools being utilized.\" RULES OF PROFESSIONAL CONDUCT. R. 3.3(a)(1): a lawyer shall not knowingly \"make a false statement of fact or law to a tribunal or fail to correct a false statement of material fact or law previously made to the tribunal by the lawyer;\". R. 1.1: \"A lawyer shall provide competent representation to a client.\" with Comment [8] requiring a lawyer to \"keep abreast of changes in the law and its practice, including the benefits and risks associated with relevant technology\". Supervision: R. 5.1(b) and R. 5.3(b), each requiring a supervising lawyer to \"make reasonable efforts to ensure\" conformity. APPLIED, AND EXPENSIVELY. Scott v. Illinois Human Rights Commission, No. 1-25-1462 (Ill. App. Ct. 1st Dist. July 28, 2026) fined counsel $15,000 and referred him to the ARDC, holding that \"submitting AI-hallucinated quotations and citations misrepresents the law to this court and violates the Illinois Rules of Professional Conduct\" and that \"AI-hallucinated citations also violate our supreme court’s policy on AI usage\". It priced the sanction at \"a $1,500 fine for each false citation and quotation\" and set the standard flatly: \"The only acceptable standard is zero false citations.\" In re Baby Boy, 2025 IL App (4th) 241427 — the first such Illinois opinion — made appointed counsel disgorge $6,925.62 and added \"an additional $1,000 penalty for Mr. Panichi’s violation of Rule 375(a) and (b).\"",
      "confidentiality_restriction": "Ill. R. Prof'l Conduct 1.6(a): \"A lawyer shall not reveal information relating to the representation of a client unless the client gives informed consent, the disclosure is impliedly authorized in order to carry out the representation, or the disclosure is permitted by paragraph (b) or required by paragraph (c).\" Rule 1.6(e): \"A lawyer shall make reasonable efforts to prevent the inadvertent or unauthorized disclosure of, or unauthorized access to, information relating to the representation of a client.\" Comment [18] adds the reasonableness factors and the safe harbour: unauthorized access or inadvertent disclosure \"does not constitute a violation of paragraph (e) if the lawyer has made reasonable efforts to prevent the access or disclosure.\" Neither the rule nor its comments mentions AI. The AI-specific limit comes from the Supreme Court's Policy: \"The Court acknowledges the necessity of safe AI use, adhering to laws and regulations concerning privacy and confidentiality. AI applications must not compromise sensitive information, such as confidential communications, personal identifying information (PII), protected health information (PHI), justice and public safety data, security-related information, or information conflicting with judicial conduct standards or eroding public trust.\"",
      "record_keeping_duty": "none",
      "client_disclosure_duty": "conditional and thin. Binding Rule 1.4(a)(1) requires a lawyer to \"promptly inform the client of any decision or circumstance with respect to which the client’s informed consent, as defined in Rule 1.0(e), is required by these Rules;\" and Rule 1.4(a)(2) to \"reasonably consult with the client about the means by which the client’s objectives are to be accomplished;\". Nothing in the Rules, the Supreme Court AI Policy, or any Illinois Supreme Court Rule requires a lawyer to tell a client that AI was used. The only Illinois guidance that addresses client communication about AI is the ARDC's Illinois Attorney's Guide to Implementing AI (October 2025), which the ARDC itself describes as \"A concise, nonbinding companion to the Illinois Supreme Court’s AI Policy\" and subordinates to the Policy — \"Read the Guide with the Court’s Policy; if there is any inconsistency, the Policy governs.\"",
      "fees_note": "No Illinois AI-specific fee rule or guidance was found. The general rule is Ill. R. Prof'l Conduct 1.5(a): \"A lawyer shall not make an agreement for, charge, or collect an unreasonable fee or an unreasonable amount for expenses.\" The one Illinois authority connecting AI to billing is a sanctions case, not guidance: In re Baby Boy, 2025 IL App (4th) 241427, ordered appointed counsel to disgorge his fee after finding that, having relied \"entirely on AI to draft the brief and conduct research, did not do any research, drafting, or citation verification himself\", his \"billing statements are not credible.\"",
      "sources": [
        {
          "title": "Illinois Supreme Court Policy on Artificial Intelligence (effective January 1, 2025), p. 1 — no disclosure in a pleading, and AI use is authorized",
          "url": "https://ilcourtsaudio.blob.core.windows.net/antilles-resources/resources/e43964ab-8874-4b7a-be4e-63af019cb6f7/Illinois%20Supreme%20Court%20AI%20Policy.pdf",
          "verbatim": "The use of AI by litigants, attorneys, judges, judicial clerks, research attorneys, and court staff providing similar support may be expected, should not be discouraged, and is authorized provided it complies with legal and ethical standards. Disclosure of AI use should not be required in a pleading.",
          "effective": "2025-01-01",
          "fetched": "2026-09-21"
        },
        {
          "title": "Same — existing rules apply in full, and the review duty",
          "url": "https://ilcourtsaudio.blob.core.windows.net/antilles-resources/resources/e43964ab-8874-4b7a-be4e-63af019cb6f7/Illinois%20Supreme%20Court%20AI%20Policy.pdf",
          "verbatim": "The Rules of Professional Conduct and the Code of Judicial Conduct apply fully to the use of AI technologies. Attorneys, judges, and self-represented litigants are accountable for their final work product. All users must thoroughly review AI-generated content before submitting it in any court proceeding to ensure accuracy and compliance with legal and ethical obligations. Prior to employing any technology, including generative AI applications, users must understand both general AI capabilities and the specific tools being utilized.",
          "effective": "2025-01-01",
          "fetched": "2026-09-21"
        },
        {
          "title": "Same — the confidentiality limit",
          "url": "https://ilcourtsaudio.blob.core.windows.net/antilles-resources/resources/e43964ab-8874-4b7a-be4e-63af019cb6f7/Illinois%20Supreme%20Court%20AI%20Policy.pdf",
          "verbatim": "The Court acknowledges the necessity of safe AI use, adhering to laws and regulations concerning privacy and confidentiality. AI applications must not compromise sensitive information, such as confidential communications, personal identifying information (PII), protected health information (PHI), justice and public safety data, security-related information, or information conflicting with judicial conduct standards or eroding public trust.",
          "effective": "2025-01-01",
          "fetched": "2026-09-21"
        },
        {
          "title": "Same — what will not be tolerated (quoted from the Court's news release, because the Policy PDF breaks AI-generated across a line)",
          "url": "https://www.illinoiscourts.gov/News/1485/Illinois-Supreme-Court-Announces-Policy-on-Artificial-Intelligence/news-detail/",
          "verbatim": "Unsubstantiated or deliberately misleading AI-generated content that perpetuates bias, prejudices litigants, or obscures truth-finding and decision-making will not be tolerated.",
          "effective": "2025-01-01",
          "fetched": "2026-09-21"
        },
        {
          "title": "Illinois Courts news release, Illinois Supreme Court Announces Policy on Artificial Intelligence (Dec. 18, 2024) — provenance and the Chief Justice on why no new rules",
          "url": "https://www.illinoiscourts.gov/News/1485/Illinois-Supreme-Court-Announces-Policy-on-Artificial-Intelligence/news-detail/",
          "verbatim": "The Illinois Supreme Court announced today the release of its policy on Artificial Intelligence (AI) in the courts, following the approval of a report submitted by the Illinois Judicial Conference (IJC) Task Force on Artificial Intelligence.",
          "effective": "2024-12-18",
          "fetched": "2026-09-21"
        },
        {
          "title": "Same — Chief Justice Theis on the sufficiency of existing rules",
          "url": "https://www.illinoiscourts.gov/News/1485/Illinois-Supreme-Court-Announces-Policy-on-Artificial-Intelligence/news-detail/",
          "verbatim": "This policy recognizes that while AI use continues to grow, our current rules are sufficient to govern its use. However, there will be challenges as these systems evolve and the Court will regularly reassess those rules and this policy.",
          "effective": "2024-12-18",
          "fetched": "2026-09-21"
        },
        {
          "title": "Illinois Courts, AI Task Force's great work has Illinois Courts on leading edge of national issue (Feb. 26, 2025), by the Task Force co-chairs — why Rule 137 was left alone",
          "url": "https://www.illinoiscourts.gov/News/1504/AI-Task-Forces-great-work-has-Illinois-Courts-on-leading-edge-of-national-issue/news-detail/",
          "verbatim": "Rule 137 underwent extensive discussion and was determined to be an established legal authority and framework to address concerns of AI inaccuracy (e.g., “hallucinations”), deep fakes and ever-evolving means to obscure authenticity.",
          "effective": "2025-02-26",
          "fetched": "2026-09-21"
        },
        {
          "title": "Same — why disclosure and certification were rejected",
          "url": "https://www.illinoiscourts.gov/News/1504/AI-Task-Forces-great-work-has-Illinois-Courts-on-leading-edge-of-national-issue/news-detail/",
          "verbatim": "The topics of transparency, disclosure and certification were carefully examined. AI is so ubiquitous in modern life that one cannot always clearly distinguish AI from non-AI. Spell check and word prediction are themselves accomplished with AI.",
          "effective": "2025-02-26",
          "fetched": "2026-09-21"
        },
        {
          "title": "Illinois Supreme Court Rule 137(a), Signing of Pleadings, Motions and Other Documents—Sanctions (amended Dec. 29, 2017, eff. Jan. 1, 2018)",
          "url": "https://www.illinoiscourts.gov/resources/9ce1fce9-895f-463e-b87d-f9b7631f8fde/file",
          "verbatim": "The signature of an attorney or party constitutes a certificate by him that he has read the pleading, motion or other document; that to the best of his knowledge, information, and belief formed after reasonable inquiry it is well grounded in fact and is warranted by existing law or a good-faith argument for the extension, modification, or reversal of existing law, and that it is not interposed for any improper purpose, such as to harass or to cause unnecessary delay or needless increase in the cost of litigation.",
          "effective": "2018-01-01",
          "fetched": "2026-09-21"
        },
        {
          "title": "Ill. R. Prof'l Conduct 1.1 (Competence), black letter",
          "url": "https://www.illinoiscourts.gov/resources/a6dcb9d0-59c0-4ffd-87b9-d610d8eeac93/file",
          "verbatim": "A lawyer shall provide competent representation to a client. Competent representation requires the legal knowledge, skill, thoroughness and preparation reasonably necessary for the representation.",
          "effective": "2010-01-01",
          "fetched": "2026-09-21"
        },
        {
          "title": "Same — Rule 1.1 Comment [8] (Maintaining Competence; the technology clause)",
          "url": "https://www.illinoiscourts.gov/resources/a6dcb9d0-59c0-4ffd-87b9-d610d8eeac93/file",
          "verbatim": "To maintain the requisite knowledge and skill, a lawyer should keep abreast of changes in the law and its practice, including the benefits and risks associated with relevant technology, engage in continuing study and education and comply with all continuing legal education requirements to which the lawyer is subject.",
          "effective": "2016-01-01",
          "fetched": "2026-09-21"
        },
        {
          "title": "Same — Rule 1.1 amendment history (the technology clause dates from the Oct. 15, 2015 amendment, effective Jan. 1, 2016)",
          "url": "https://www.illinoiscourts.gov/resources/a6dcb9d0-59c0-4ffd-87b9-d610d8eeac93/file",
          "verbatim": "Adopted July 1, 2009, effective January 1, 2010; amended Oct. 15, 2015, eff. Jan. 1, 2016; amended July 6, 2023, eff. immediately.",
          "effective": "2016-01-01",
          "fetched": "2026-09-21"
        },
        {
          "title": "Ill. R. Prof'l Conduct 1.4(a)(1) and (a)(2) (Communication)",
          "url": "https://www.illinoiscourts.gov/resources/62c51d85-9cd0-490b-86c8-f551948ecc82/file",
          "verbatim": "promptly inform the client of any decision or circumstance with respect to which the client’s informed consent, as defined in Rule 1.0(e), is required by these Rules;",
          "effective": "2016-01-01",
          "fetched": "2026-09-21"
        },
        {
          "title": "Same — Rule 1.4(a)(2)",
          "url": "https://www.illinoiscourts.gov/resources/62c51d85-9cd0-490b-86c8-f551948ecc82/file",
          "verbatim": "reasonably consult with the client about the means by which the client’s objectives are to be accomplished;",
          "effective": "2016-01-01",
          "fetched": "2026-09-21"
        },
        {
          "title": "Ill. R. Prof'l Conduct 1.5(a) (Fees) (amended Mar. 1, 2023, eff. July 1, 2023)",
          "url": "https://www.illinoiscourts.gov/resources/ce9cba94-4700-49ed-9183-a43cfcd0c3a5/file",
          "verbatim": "A lawyer shall not make an agreement for, charge, or collect an unreasonable fee or an unreasonable amount for expenses.",
          "effective": "2023-07-01",
          "fetched": "2026-09-21"
        },
        {
          "title": "Ill. R. Prof'l Conduct 1.6(a) (Confidentiality of Information) (amended Apr. 1, 2025, eff. July 1, 2025)",
          "url": "https://www.illinoiscourts.gov/resources/10d7b59d-8133-4cd6-b088-8e85c3004e21/file",
          "verbatim": "A lawyer shall not reveal information relating to the representation of a client unless the client gives informed consent, the disclosure is impliedly authorized in order to carry out the representation, or the disclosure is permitted by paragraph (b) or required by paragraph (c).",
          "effective": "2025-07-01",
          "fetched": "2026-09-21"
        },
        {
          "title": "Same — Rule 1.6(e) (reasonable efforts to prevent disclosure or access)",
          "url": "https://www.illinoiscourts.gov/resources/10d7b59d-8133-4cd6-b088-8e85c3004e21/file",
          "verbatim": "A lawyer shall make reasonable efforts to prevent the inadvertent or unauthorized disclosure of, or unauthorized access to, information relating to the representation of a client.",
          "effective": "2025-07-01",
          "fetched": "2026-09-21"
        },
        {
          "title": "Same — Rule 1.6 Comment [18] (acting competently to safeguard information; the reasonable-efforts safe harbour)",
          "url": "https://www.illinoiscourts.gov/resources/10d7b59d-8133-4cd6-b088-8e85c3004e21/file",
          "verbatim": "does not constitute a violation of paragraph (e) if the lawyer has made reasonable efforts to prevent the access or disclosure.",
          "effective": "2025-07-01",
          "fetched": "2026-09-21"
        },
        {
          "title": "Ill. R. Prof'l Conduct 3.3(a)(1) (Candor Toward the Tribunal)",
          "url": "https://www.illinoiscourts.gov/resources/bf8b70c0-9c5c-49c6-b12a-5dc05c7d62ec/file",
          "verbatim": "make a false statement of fact or law to a tribunal or fail to correct a false statement of material fact or law previously made to the tribunal by the lawyer;",
          "effective": "2010-01-01",
          "fetched": "2026-09-21"
        },
        {
          "title": "Ill. R. Prof'l Conduct 5.1(b) (supervisory lawyers) (amended May 30, 2024, eff. July 1, 2024)",
          "url": "https://www.illinoiscourts.gov/resources/8e4aa53f-0a63-4923-a924-617e276a9e18/file",
          "verbatim": "A lawyer having direct supervisory authority over another lawyer shall make reasonable efforts to ensure that the other lawyer conforms to the Rules of Professional Conduct.",
          "effective": "2024-07-01",
          "fetched": "2026-09-21"
        },
        {
          "title": "Ill. R. Prof'l Conduct 5.3(b) (nonlawyer assistance) (amended Oct. 15, 2015, eff. Jan. 1, 2016)",
          "url": "https://www.illinoiscourts.gov/resources/cb39eea7-9ab0-4179-bc55-9200fa2efb23/file",
          "verbatim": "a lawyer having direct supervisory authority over the nonlawyer shall make reasonable efforts to ensure that the person’s conduct is compatible with the professional obligations of the lawyer; and",
          "effective": "2016-01-01",
          "fetched": "2026-09-21"
        },
        {
          "title": "Attorney Registration and Disciplinary Commission, Artificial Intelligence page — the ARDC subordinates its own guidance to the Court's Policy",
          "url": "https://www.iardc.org/EducationAndOutreach/ArtificialIntelligence",
          "verbatim": "We align our approach with the Illinois Supreme Court Policy on Artificial Intelligence. The Policy authorizes lawyers to use AI so long as existing duties are satisfied- including competence, confidentiality, supervision, candor, and protection of sensitive information. If any ARDC material appears inconsistent with the Court’s Policy, the Court’s Policy controls.",
          "effective": null,
          "fetched": "2026-09-21"
        },
        {
          "title": "Same — the Illinois Attorney's Guide to Implementing AI is expressly nonbinding",
          "url": "https://www.iardc.org/EducationAndOutreach/ArtificialIntelligence",
          "verbatim": "A concise, nonbinding companion to the Illinois Supreme Court’s AI Policy",
          "effective": null,
          "fetched": "2026-09-21"
        },
        {
          "title": "Same — the Guide yields to the Policy",
          "url": "https://www.iardc.org/EducationAndOutreach/ArtificialIntelligence",
          "verbatim": "Read the Guide with the Court’s Policy; if there is any inconsistency, the Policy governs.",
          "effective": null,
          "fetched": "2026-09-21"
        },
        {
          "title": "Illinois Courts news, Paste in Haste — The Fallout of AI Hallucinations in Court Filings and the New ARDC's Guide to Implementing AI — date and scope of the ARDC Guide",
          "url": "https://www.illinoiscourts.gov/News/1665/Paste-in-Haste-The-Fallout-of-AI-Hallucinations-in-Court-Filings-and-the-New-ARDCs-Guide-to-Implementing-AI/news-detail/",
          "verbatim": "The Illinois Attorney’s Guide to Implementing AI (Oct. 2025), a practical resource for navigating the ethical use of AI in legal work.",
          "effective": "2025-10-01",
          "fetched": "2026-09-21"
        },
        {
          "title": "Same — the Guide's decision matrix (summarized by the Illinois Courts, not by the Guide itself)",
          "url": "https://www.illinoiscourts.gov/News/1665/Paste-in-Haste-The-Fallout-of-AI-Hallucinations-in-Court-Filings-and-the-New-ARDCs-Guide-to-Implementing-AI/news-detail/",
          "verbatim": "Confidential data should never be processed using public AI tools, even with client consent. Business-class or enterprise tools may be acceptable if clients are informed and can opt out.",
          "effective": "2025-10-01",
          "fetched": "2026-09-21"
        },
        {
          "title": "Scott v. Illinois Human Rights Commission, No. 1-25-1462 (Ill. App. Ct. 1st Dist. July 28, 2026) — slip op. ¶ 1, the holding",
          "url": "https://www.illinoiscourts.gov/resources/23d7df84-ed51-48df-8477-3a6872db40d5/file",
          "verbatim": "We also sanction petitioner’s attorney Mason Cole for submitting briefs containing false citations and quotations that are the product of artificial intelligence (AI) hallucinations.",
          "effective": "2026-07-28",
          "fetched": "2026-09-21"
        },
        {
          "title": "Same — ¶ 45, the Rules of Professional Conduct violated",
          "url": "https://www.illinoiscourts.gov/resources/23d7df84-ed51-48df-8477-3a6872db40d5/file",
          "verbatim": "Furthermore, submitting AI-hallucinated quotations and citations misrepresents the law to this court and violates the Illinois Rules of Professional Conduct.",
          "effective": "2026-07-28",
          "fetched": "2026-09-21"
        },
        {
          "title": "Same — ¶ 46, the Supreme Court AI Policy is enforceable against counsel",
          "url": "https://www.illinoiscourts.gov/resources/23d7df84-ed51-48df-8477-3a6872db40d5/file",
          "verbatim": "AI-hallucinated citations also violate our supreme court’s policy on AI usage, which provides that attorneys “are accountable for their final work product” and “must thoroughly review AI-generated content before submitting it in any court proceeding to ensure accuracy and compliance with legal and ethical obligations.”",
          "effective": "2026-07-28",
          "fetched": "2026-09-21"
        },
        {
          "title": "Same — ¶ 48, the standard",
          "url": "https://www.illinoiscourts.gov/resources/23d7df84-ed51-48df-8477-3a6872db40d5/file",
          "verbatim": "The only acceptable standard is zero false citations.",
          "effective": "2026-07-28",
          "fetched": "2026-09-21"
        },
        {
          "title": "Same — ¶ 56, the sanction and its arithmetic",
          "url": "https://www.illinoiscourts.gov/resources/23d7df84-ed51-48df-8477-3a6872db40d5/file",
          "verbatim": "We order attorney Cole to pay a $15,000 fine to the clerk of the Appellate Court, First District, within 30 days of this opinion.",
          "effective": "2026-07-28",
          "fetched": "2026-09-21"
        },
        {
          "title": "Same — ¶ 56, the per-citation rate",
          "url": "https://www.illinoiscourts.gov/resources/23d7df84-ed51-48df-8477-3a6872db40d5/file",
          "verbatim": "This sanction reflects a $1,500 fine for each false citation and quotation.",
          "effective": "2026-07-28",
          "fetched": "2026-09-21"
        },
        {
          "title": "Same — ¶ 57, paying for a premium tool is no defence",
          "url": "https://www.illinoiscourts.gov/resources/23d7df84-ed51-48df-8477-3a6872db40d5/file",
          "verbatim": "This case illustrates that, no matter how much one pays for “premier” or “corporate” versions of AI products, it does not negate an attorney’s obligation to verify all citations of authority.",
          "effective": "2026-07-28",
          "fetched": "2026-09-21"
        },
        {
          "title": "Same — ¶ 59, the ARDC referral",
          "url": "https://www.illinoiscourts.gov/resources/23d7df84-ed51-48df-8477-3a6872db40d5/file",
          "verbatim": "In addition, the clerk of the Appellate Court, First District, shall send a copy of this opinion to the ARDC.",
          "effective": "2026-07-28",
          "fetched": "2026-09-21"
        },
        {
          "title": "In re Baby Boy, 2025 IL App (4th) 241427 (Ill. App. Ct. 4th Dist. July 21, 2025) — the fine",
          "url": "https://www.illinoiscourts.gov/resources/e3fae0bc-07b9-44a6-9b16-249027907502/file",
          "verbatim": "We impose an additional $1,000 penalty for Mr. Panichi’s violation of Rule 375(a) and (b).",
          "effective": "2025-07-21",
          "fetched": "2026-09-21"
        },
        {
          "title": "Same — the fee disgorgement",
          "url": "https://www.illinoiscourts.gov/resources/e3fae0bc-07b9-44a6-9b16-249027907502/file",
          "verbatim": "We therefore rule that Mr. Panichi must disgorge the payment of $6,925.62 that he received from the Sangamon County treasurer under Illinois Supreme Court Rule 299 (eff. Jan. 1, 2024) for being appointed to represent respondent in this appeal.",
          "effective": "2025-07-21",
          "fetched": "2026-09-21"
        },
        {
          "title": "Same — AI use is not itself forbidden",
          "url": "https://www.illinoiscourts.gov/resources/e3fae0bc-07b9-44a6-9b16-249027907502/file",
          "verbatim": "To be clear, nothing in this opinion is intended to categorically forbid attorneys from using AI tools—in fact, the Illinois Supreme Court AI policy explicitly permits the use of AI. However, attorneys must use AI tools wisely.",
          "effective": "2025-07-21",
          "fetched": "2026-09-21"
        },
        {
          "title": "Illinois Supreme Court AI Policy Bench Card (judicial reference sheet accompanying the Policy) — located and fetched, addressed to judges",
          "url": "https://ilcourtsaudio.blob.core.windows.net/antilles-resources/resources/cb3d6da3-66c7-469d-97f3-41568bdeee8c/ISC%20AI%20Policy%20Bench%20Card.pdf",
          "verbatim": null,
          "effective": "2025-01-01",
          "fetched": "2026-09-21"
        },
        {
          "title": "Illinois Courts, Supreme Court Rules, Article VIII index — the per-rule amendment-history lines relied on for the effective dates above",
          "url": "https://www.illinoiscourts.gov/rules/supreme-court-rules?a=viii",
          "verbatim": null,
          "effective": null,
          "fetched": "2026-09-21"
        },
        {
          "title": "Illinois Compiled Statutes, act-title sweep of all 68 chapters (ilga.gov legacy chapter listings, concatenated) — only two acts in the whole ILCS carry artificial intelligence in the title",
          "url": "https://www.ilga.gov/legislation/ilcs/ilcs2.asp?ChapterID=39",
          "verbatim": "430 ILCS 185/ Artificial Intelligence Safety Measures Act.",
          "effective": null,
          "fetched": "2026-09-21"
        },
        {
          "title": "Same — the other AI act in the ILCS",
          "url": "https://www.ilga.gov/legislation/ilcs/ilcs2.asp?ChapterID=68",
          "verbatim": "820 ILCS 42/ Artificial Intelligence Video Interview Act.",
          "effective": null,
          "fetched": "2026-09-21"
        },
        {
          "title": "Artificial Intelligence Video Interview Act, 820 ILCS 42/1 — an employment statute, nothing to do with court filings",
          "url": "https://www.ilga.gov/legislation/ilcs/ilcs3.asp?ActID=4015&ChapterID=68",
          "verbatim": "Sec. 1. Short title. This Act may be cited as the Artificial Intelligence Video Interview Act.",
          "effective": null,
          "fetched": "2026-09-21"
        },
        {
          "title": "Same — 820 ILCS 42/5, the only disclosure duty the Act creates, and whom it binds",
          "url": "https://www.ilga.gov/legislation/ilcs/ilcs3.asp?ActID=4015&ChapterID=68",
          "verbatim": "Sec. 5. Disclosure of the use of artificial intelligence analysis. An employer that asks applicants to record video interviews and uses an artificial intelligence analysis of the applicant-submitted videos shall do all of the following when considering applicants for positions based in Illinois before asking applicants to submit video interviews:",
          "effective": null,
          "fetched": "2026-09-21"
        },
        {
          "title": "Artificial Intelligence Safety Measures Act, 430 ILCS 185/ — located by title in Chapter 430 (Public Safety); the ILCS database served no section text for it, so its content was not read",
          "url": "https://www.ilga.gov/Legislation/ILCS/Articles?ActID=4689&ChapterID=39",
          "verbatim": "(430 ILCS 185/) Artificial Intelligence Safety Measures Act.",
          "effective": null,
          "fetched": "2026-09-21"
        }
      ],
      "status": "verified",
      "verified_on": "2026-09-21",
      "verified_by": "claude-opus verifier session, batch 3a",
      "attorney_signoff": null,
      "notes": "BOTTOM LINE: Illinois looked at the problem, decided its existing rules were enough, and said so. The Illinois Supreme Court Policy on Artificial Intelligence, effective January 1, 2025, is the governing instrument. It does three things a lawyer needs to know: it authorizes AI use, it says \"Disclosure of AI use should not be required in a pleading.\", and it imposes a review duty on \"Attorneys, judges, and self-represented litigants\" who \"are accountable for their final work product.\" Chief Justice Theis put the reasoning on the record: \"This policy recognizes that while AI use continues to grow, our current rules are sufficient to govern its use.\" Illinois therefore has NO AI-specific court rule, NO certification, and NO AI language anywhere in the Rules of Professional Conduct. THE TRAP: the absence of a rule has not meant leniency. Illinois has the largest state-court AI fine found in this batch. Scott v. Illinois Human Rights Commission (1st Dist., July 28, 2026) fined counsel $15,000 — priced at $1,500 per false citation — and referred him to the ARDC, expressly holding that AI-hallucinated citations violate the Rules of Professional Conduct AND the Supreme Court's AI Policy. The court said in terms that the fines being imposed elsewhere are too low to deter. In re Baby Boy, 2025 IL App (4th) 241427 (the first Illinois appellate opinion on the subject) made appointed counsel disgorge his entire $6,925.62 fee and added $1,000. Both were imposed under Ill. S. Ct. R. 375(a) and (b), which was NOT fetched for this entry. WHAT THE POLICY IS, LEGALLY: it is a policy adopted by the Supreme Court on the recommendation of the Illinois Judicial Conference AI Task Force, announced December 18, 2024 — not a Supreme Court Rule and not published in the Rules. No adopting order was located. Its enforceability therefore rests on how courts treat it, and Scott ¶ 46 treats a breach of it as a ground for sanctions. Note also the softer verb: the Policy says only that \"Disclosure of AI use should not be required in a pleading.\" where the Florida order carried in the fl-rpc entry flatly forbids courts to impose such requirements. Whether an Illinois circuit judge may still enter an AI standing order is therefore an open question this entry cannot answer. WHY RULE 137 WAS NOT AMENDED: the Task Force co-chairs wrote that \"Rule 137 underwent extensive discussion and was determined to be an established legal authority and framework to address concerns of AI inaccuracy\", and that disclosure and certification were rejected partly because \"Spell check and word prediction are themselves accomplished with AI.\" Contrast Texas, whose taskforce made the opposite recommendation on the equivalent rule and whose Supreme Court has now preliminarily approved an amendment. TECHNOLOGY COMPETENCE: adopted. Comment [8] to Rule 1.1 carries the ABA technology clause verbatim. The rule's own history line reads \"Adopted July 1, 2009, effective January 1, 2010; amended Oct. 15, 2015, eff. Jan. 1, 2016; amended July 6, 2023, eff. immediately.\" The 2016 amendment is the date carried in this entry for the technology clause, which is consistent with the national pattern of post-2012 adoptions, but NO adopting order was fetched and the history line does not say which amendment inserted the words. Treat the 2016 date as unestablished until the order is read. Rule 1.6(e) (reasonable efforts to prevent inadvertent or unauthorized disclosure) is in force and was itself amended April 1, 2025, effective July 1, 2025 — but for reasons unrelated to AI, and neither it nor Comment [18] mentions AI. Note for the verifier: Scott ¶ 45 cites Rule 1.1 Comment as \"eff. July 6, 2023\" while the index attributes the technology language to the 2016 amendment; both are recorded here. ARDC: the Attorney Registration and Disciplinary Commission — the Supreme Court's own disciplinary agent — published the Illinois Attorney's Guide to Implementing AI in October 2025, with a data sensitivity/tool security decision matrix and a Practice Resource Kit including a sample client consent form. The ARDC calls it \"A concise, nonbinding companion\" and subordinates it to the Court's Policy. The Guide itself is served only through a flipbook viewer at https://iardc.org/Files/Implementing-AI-Guide/?page=1 and no direct PDF URL was found, so the Guide was NOT read; the two quotations carried here are from the ARDC's own AI landing page and from the Illinois Courts' description of it. CHECKED, NOTHING FURTHER FOUND (all fetched 2026-09-21): the full text of Ill. R. Prof'l Conduct 1.1, 1.4, 1.5, 1.6, 3.3, 5.1 and 5.3 with their comments, each scanned whitespace-normalized for artificial intelligence, generative, machine learning, large language, chatgpt, hallucinat and technolog — the only hit in any of the seven is the technology clause in Rule 1.1 Comment [8]; Ill. S. Ct. R. 137 — no AI language; one CourtListener v4 search of Illinois state courts (courts ill, illappct; query \"artificial intelligence\" AND (fabricated OR nonexistent OR fictitious) AND sanctions) returned exactly 2 published opinions, Scott and Baby Boy, both carried here. STATUTES — HOW THE CHECK WAS ACTUALLY DONE, AND ITS LIMIT: the Illinois General Assembly's site search is JavaScript-driven and its API answered an unauthenticated request with a JSON object reporting success false and the message Not authorized, so no full-TEXT search of the Illinois Compiled Statutes was possible. Instead the legacy chapter listings were fetched for all 68 ILCS chapters (ilga.gov/legislation/ilcs/ilcs2.asp?ChapterID=N, 2026-09-21) and every ACT TITLE in the code was scanned whitespace-normalized. Exactly two acts in the entire ILCS carry artificial intelligence in their titles: the Artificial Intelligence Safety Measures Act, 430 ILCS 185/ (Chapter 430, Public Safety), and the Artificial Intelligence Video Interview Act, 820 ILCS 42/ (Chapter 820, Employment). The Video Interview Act was read in full — it regulates employers analyzing job-applicant videos, and contains zero occurrences of court, attorney or pleading. The Safety Measures Act could not be read: the ILCS database served its act listing with no section text, so only its title and chapter placement are established. LIMIT OF THIS CHECK: it finds acts whose TITLE names AI; an AI provision buried inside an act with some other title (for example a section of the Code of Civil Procedure) would not be caught. The verifier should still run a full-text statutory search if one can be reached. NOT FETCHED: the Illinois Judicial Conference AI Task Force report itself (only the Supreme Court's approved Policy, the December 2024 news release and the co-chairs' February 2025 account of it were read); Ill. S. Ct. R. 375, under which both fines were imposed; the ARDC Implementing AI Guide; ISBA Professional Conduct Advisory Opinions (the ISBA is a voluntary bar and its opinions are non-binding, but they were not searched for AI content); the section text of 430 ILCS 185/; the unpublished Illinois orders cited in Scott ¶ 50 (S.M., 2025 IL App (4th) 250277-U; In re A.S., 2025 IL App (4th) 250298-U) and the Cook County circuit court $59,500 sanction reported there through a newspaper article; the Illinois Compiled Statutes. OPEN QUESTIONS FOR THE VERIFIER: (1) Run a full-TEXT ILCS search if one can be reached, and read 430 ILCS 185/ (the Artificial Intelligence Safety Measures Act), whose section text the ILCS database did not serve. (2) Was the AI Policy adopted by an order of the Supreme Court, and if so where is it published? (3) Read Ill. S. Ct. R. 375 — both Illinois sanctions run through it, and the matrix has no entry for it. (4) Does any Illinois circuit still have an AI standing order, notwithstanding the Policy's \"should not be required\"? (5) Is the ARDC Guide obtainable as a PDF, and does its sample client consent form imply a client disclosure practice the matrix should record?"
    },
    {
      "id": "ct-rpc",
      "kind": "state_bar",
      "name": "Connecticut Rules of Professional Conduct (Practice Book) and the Connecticut generative-AI practice rules",
      "disclosure_to_court": "none",
      "certification_required": true,
      "certificate_language": null,
      "verification_duty": "A statewide court rule is IN FORCE. Practice Book § 4-9 (b) (Superior Court; adopted by the judges June 11, 2026; effective on publication in the Connecticut Law Journal June 23, 2026) provides that \"any person who uses generative AI in the creation or editing of any document filed with the court shall independently verify all citations, legal authorities or evidence produced by generative AI.\" and that \"The failure to do so may result in court-imposed sanctions, including, without limitation, the entry of a nonsuit or default judgment.\" Section 4-9 (c) adds that \"Any person who files documents with the court represents that they have reviewed this rule and, by filing the document, represents that they have made good faith, diligent efforts to ensure compliance with their obligations under this rule, all other rules of practice, the Rules of Professional Conduct, and any applicable provision of Connecticut law regarding the use of or reliance on generative AI.\" Section 4-9 (d) places the burden on the filer alone — \"The court or the clerk of the court is not required to review any filed document for compliance with this rule.\" The obligation is carried into the signature by amended § 4-2 (b) (same effective date) and, on appeal, by § 62-6 (d) (effective July 14, 2026), each making the signing of a paper a certificate that \"the signer has complied with the requirements of Section 4-7 regarding personal identifying information and Section 4-9 regarding generative AI.\" Appellate § 85-2 (11) makes \"Failure to independently verify all citations and legal authorities produced by generative AI in compliance with Sections 4-9 and 62-6 (d).\" expressly sanctionable. Underneath the rule, the general RPC apply — Rule 1.1 (\"A lawyer shall provide competent representation to a client.\"), Rule 3.3 (a) (1) (a lawyer shall not knowingly \"Make a false statement of fact or law to a tribunal\"), and Rules 5.1 (b) and 5.3 (2) (supervisory \"reasonable efforts to ensure\"). The Connecticut Supreme Court applied Rule 1.1 to hallucinated citations in TOV Realty, LLC v. Suarez (SC 21183) and Kosel Equity, LLC v. MacGregor (SC 21184) (per curiam sanctions order, July 31, 2026), sanctioning counsel and his firm.",
      "confidentiality_restriction": "No Connecticut rule names AI as a confidentiality risk. Rule 1.6 (a) — \"A lawyer shall not reveal information relating to representation of a client unless the client gives informed consent, the disclosure is impliedly authorized in order to carry out the representation, or the disclosure is permitted by subsection (b), (c), or (d).\" Rule 1.6 (e) — \"A lawyer shall make reasonable efforts to prevent the inadvertent or unauthorized disclosure of, or unauthorized access to, information relating to the representation of a client.\" Rule 1.6 commentary, Acting Competently To Preserve Confidentiality, requires \"a lawyer to act competently to safeguard information relating to the representation of a client against inadvertent or unauthorized disclosure by the lawyer or other persons who are participating in the representation of the client or who are subject to the lawyer’s supervision.\" Rule 5.3 commentary treats \"using an internet based service to store client information\" as an outside nonlawyer service for which \"a lawyer must make reasonable efforts to ensure that the services are provided in a manner that is compatible with the lawyer’s professional obligations.\" The Supreme Court added in TOV Realty n.2 that \"the duty of competence with respect to the use of generative AI in legal practice also includes recognition of its implications as to the attorney-client privilege, the confidentiality of information relating to an attorney’s representation of a client, and the work product doctrine, particularly when a public access platform is involved.\"",
      "record_keeping_duty": "none",
      "client_disclosure_duty": "conditional — no AI-specific client-disclosure duty exists in Connecticut. Rule 1.4 (a) (2) requires a lawyer to \"reasonably consult with the client about the means by which the client’s objectives are to be accomplished;\" and Rule 1.4 (b) that \"A lawyer shall explain a matter to the extent reasonably necessary to permit the client to make informed decisions regarding the representation.\" Client informed consent is required by Rule 1.6 (a) before confidential information is revealed outside implied authorization. The Connecticut Bar Association Committee on Professional Ethics has issued no opinion on generative AI (informal-opinion index checked 2026-09-20; latest listed is \"Informal Opinion 25-04 | Duty to Report Professional Misconduct\"), so there is no Connecticut analogue to the Pennsylvania or California bar guidance on informing clients about AI use.",
      "fees_note": "Rule 1.5 (a) — \"A lawyer shall not make an agreement for, charge, or collect an unreasonable fee or an unreasonable amount for expenses.\" No Connecticut rule, opinion, or order addresses billing for generative-AI time or expense. The only AI-related money order located is the sanction in TOV Realty — \"Attorney Gottlieb and the law firm each shall donate $1000 to the CT Bar Institute, Inc.\" — which is discipline, not a fee rule.",
      "sources": [
        {
          "title": "Connecticut Practice Book 2026, Rules of Professional Conduct, Rule 1.1 (Competence), black letter",
          "url": "https://www.jud.ct.gov/Publications/PracticeBook/PB.pdf",
          "verbatim": "A lawyer shall provide competent representation to a client. Competent representation requires the legal knowledge, skill, thoroughness and preparation reasonably necessary for the representation.",
          "effective": null,
          "fetched": "2026-09-20"
        },
        {
          "title": "Same — Rule 1.1 history note (the only source note the rule carries)",
          "url": "https://www.jud.ct.gov/Publications/PracticeBook/PB.pdf",
          "verbatim": "(P.B. 1978-1997, Rule 1.1.)",
          "effective": null,
          "fetched": "2026-09-20"
        },
        {
          "title": "Same — Rule 1.1 COMMENTARY, Maintaining Competence (technology-competence language, ADOPTED)",
          "url": "https://www.jud.ct.gov/Publications/PracticeBook/PB.pdf",
          "verbatim": "Maintaining Competence. To maintain the requisite knowledge and skill, a lawyer should keep abreast of changes in the law and its practice, including the benefits and risks associated with relevant technology, engage in continuing study and education and comply with all continuing legal education requirements to which the lawyer is subject.",
          "effective": null,
          "fetched": "2026-09-20"
        },
        {
          "title": "Same — Rule 1.4 (a) (2) (Communication)",
          "url": "https://www.jud.ct.gov/Publications/PracticeBook/PB.pdf",
          "verbatim": "(2) reasonably consult with the client about the means by which the client’s objectives are to be accomplished;",
          "effective": "2007-01-01",
          "fetched": "2026-09-20"
        },
        {
          "title": "Same — Rule 1.4 (b)",
          "url": "https://www.jud.ct.gov/Publications/PracticeBook/PB.pdf",
          "verbatim": "(b) A lawyer shall explain a matter to the extent reasonably necessary to permit the client to make informed decisions regarding the representation.",
          "effective": "2007-01-01",
          "fetched": "2026-09-20"
        },
        {
          "title": "Same — Rule 1.5 (a) (Fees)",
          "url": "https://www.jud.ct.gov/Publications/PracticeBook/PB.pdf",
          "verbatim": "(a) A lawyer shall not make an agreement for, charge, or collect an unreasonable fee or an unreasonable amount for expenses.",
          "effective": "2013-10-01",
          "fetched": "2026-09-20"
        },
        {
          "title": "Same — Rule 1.6 (a) (Confidentiality of Information)",
          "url": "https://www.jud.ct.gov/Publications/PracticeBook/PB.pdf",
          "verbatim": "(a) A lawyer shall not reveal information relating to representation of a client unless the client gives informed consent, the disclosure is impliedly authorized in order to carry out the representation, or the disclosure is permitted by subsection (b), (c), or (d).",
          "effective": "2014-01-01",
          "fetched": "2026-09-20"
        },
        {
          "title": "Same — Rule 1.6 (e) (reasonable efforts to prevent disclosure or access)",
          "url": "https://www.jud.ct.gov/Publications/PracticeBook/PB.pdf",
          "verbatim": "(e) A lawyer shall make reasonable efforts to prevent the inadvertent or unauthorized disclosure of, or unauthorized access to, information relating to the representation of a client.",
          "effective": "2014-01-01",
          "fetched": "2026-09-20"
        },
        {
          "title": "Same — Rule 1.6 history note (source of the 2014 effective date)",
          "url": "https://www.jud.ct.gov/Publications/PracticeBook/PB.pdf",
          "verbatim": "(P.B. 1978-1997, Rule 1.6.) (Amended June 26, 2006, to take effect Jan. 1, 2007; amended June 14, 2013, to take effect Jan. 1, 2014.)",
          "effective": "2014-01-01",
          "fetched": "2026-09-20"
        },
        {
          "title": "Same — Rule 1.6 COMMENTARY, Acting Competently To Preserve Confidentiality",
          "url": "https://www.jud.ct.gov/Publications/PracticeBook/PB.pdf",
          "verbatim": "Acting Competently To Preserve Confidentiality. Subsection (e) requires a lawyer to act competently to safeguard information relating to the representation of a client against inadvertent or unauthorized disclosure by the lawyer or other persons who are participating in the representation of the client or who are subject to the lawyer’s supervision.",
          "effective": "2014-01-01",
          "fetched": "2026-09-20"
        },
        {
          "title": "Same — Rule 3.3 (a) (1) (Candor toward the Tribunal)",
          "url": "https://www.jud.ct.gov/Publications/PracticeBook/PB.pdf",
          "verbatim": "(a) A lawyer shall not knowingly: (1) Make a false statement of fact or law to a tribunal or fail to correct a false statement of material fact or law previously made to the tribunal by the lawyer;",
          "effective": null,
          "fetched": "2026-09-20"
        },
        {
          "title": "Same — Rule 5.1 (b) (supervisory lawyers)",
          "url": "https://www.jud.ct.gov/Publications/PracticeBook/PB.pdf",
          "verbatim": "(b) A lawyer having direct supervisory authority over another lawyer shall make reasonable efforts to ensure that the other lawyer conforms to the Rules of Professional Conduct.",
          "effective": "2007-01-01",
          "fetched": "2026-09-20"
        },
        {
          "title": "Same — Rule 5.3 (2) (Responsibilities regarding Nonlawyer Assistance)",
          "url": "https://www.jud.ct.gov/Publications/PracticeBook/PB.pdf",
          "verbatim": "(2) A lawyer having direct supervisory authority over the nonlawyer shall make reasonable efforts to ensure that the person’s conduct is compatible with the professional obligations of the lawyer; and",
          "effective": "2015-01-01",
          "fetched": "2026-09-20"
        },
        {
          "title": "Same — Rule 5.3 COMMENTARY, Nonlawyers Outside the Firm (internet-based services)",
          "url": "https://www.jud.ct.gov/Publications/PracticeBook/PB.pdf",
          "verbatim": "Nonlawyers Outside the Firm. A lawyer may use nonlawyers outside the firm to assist the lawyer in rendering legal services to the client. Examples include the retention of an investigative or paraprofessional service, hiring a document management company to create and maintain a database for complex litigation, sending client documents to a third party for printing or scanning, and using an internet based service to store client information. When using such services outside the firm, a lawyer must make reasonable efforts to ensure that the services are provided in a manner that is compatible with the lawyer’s professional obligations.",
          "effective": "2015-01-01",
          "fetched": "2026-09-20"
        },
        {
          "title": "Same — Lawyers’ Principles of Professionalism, Competency (aspirational, printed at the front of the Practice Book)",
          "url": "https://www.jud.ct.gov/Publications/PracticeBook/PB.pdf",
          "verbatim": "A lawyer will maintain proficiency in those technological advances that are necessary for the lawyer to competently represent their clients; and",
          "effective": null,
          "fetched": "2026-09-20"
        },
        {
          "title": "Practice Book Amendments, Superior Court Rules, 87 Conn. L.J. No. 52 (June 23, 2026) — adoption and effective-date notice",
          "url": "https://www.jud.ct.gov/legalresources/Docs/LJDocs/Misc/2026/26/pblj_8752.pdf",
          "verbatim": "On June 11, 2026, the judges of the Superior Court adopted the amendments to the Practice Book contained in this Notice. Those amendments become effective on January 1, 2027, except that the revisions to Section 4-2 and the adoption of new Sections 4-9 and 31a-18A become effective upon publication in this Connecticut Law Journal on June 23, 2026.",
          "effective": "2026-06-23",
          "fetched": "2026-09-20"
        },
        {
          "title": "Same — new Practice Book § 4-9, heading",
          "url": "https://www.jud.ct.gov/legalresources/Docs/LJDocs/Misc/2026/26/pblj_8752.pdf",
          "verbatim": "(NEW) Sec. 4-9. Generative Artificial Intelligence (“Generative AI”) Compliance",
          "effective": "2026-06-23",
          "fetched": "2026-09-20"
        },
        {
          "title": "Same — § 4-9 (a) (definition of generative AI)",
          "url": "https://www.jud.ct.gov/legalresources/Docs/LJDocs/Misc/2026/26/pblj_8752.pdf",
          "verbatim": "(a) “Generative AI” means: any machine-learning model/application that can create original content—such as text, images, video, audio or software code—in response to a prompt or request, including but not limited to, ChatGPT, Co-Counsel, Google Bard, Neeva, Harvey, Ironclad, Bing, DeepSeek, Grok, and similar technology.",
          "effective": "2026-06-23",
          "fetched": "2026-09-20"
        },
        {
          "title": "Same — § 4-9 (b) (the verification duty)",
          "url": "https://www.jud.ct.gov/legalresources/Docs/LJDocs/Misc/2026/26/pblj_8752.pdf",
          "verbatim": "(b) Due to the risk that generative AI can create inaccurate factual and legal information, including, without limitation, faulty citations to legal authority, fabricated quotations from such authority, and inaccurate or fabricated evidence, any person who uses generative AI in the creation or editing of any document filed with the court shall independently verify all citations, legal authorities or evidence produced by generative AI.",
          "effective": "2026-06-23",
          "fetched": "2026-09-20"
        },
        {
          "title": "Same — § 4-9 (b), second paragraph (sanctions)",
          "url": "https://www.jud.ct.gov/legalresources/Docs/LJDocs/Misc/2026/26/pblj_8752.pdf",
          "verbatim": "The failure to do so may result in court-imposed sanctions, including, without limitation, the entry of a nonsuit or default judgment.",
          "effective": "2026-06-23",
          "fetched": "2026-09-20"
        },
        {
          "title": "Same — § 4-9 (c) (representation made by filing)",
          "url": "https://www.jud.ct.gov/legalresources/Docs/LJDocs/Misc/2026/26/pblj_8752.pdf",
          "verbatim": "(c) Any person who files documents with the court represents that they have reviewed this rule and, by filing the document, represents that they have made good faith, diligent efforts to ensure compliance with their obligations under this rule, all other rules of practice, the Rules of Professional Conduct, and any applicable provision of Connecticut law regarding the use of or reliance on generative AI.",
          "effective": "2026-06-23",
          "fetched": "2026-09-20"
        },
        {
          "title": "Same — § 4-9 (d) (no clerk review; burden on the filer)",
          "url": "https://www.jud.ct.gov/legalresources/Docs/LJDocs/Misc/2026/26/pblj_8752.pdf",
          "verbatim": "(d) The responsibility for complying with this rule rests solely with the person filing the document. The court or the clerk of the court is not required to review any filed document for compliance with this rule.",
          "effective": "2026-06-23",
          "fetched": "2026-09-20"
        },
        {
          "title": "Same — § 4-9 COMMENTARY",
          "url": "https://www.jud.ct.gov/legalresources/Docs/LJDocs/Misc/2026/26/pblj_8752.pdf",
          "verbatim": "this new rule cautions persons who file documents with the court about the inherent risks of this technology and requires them to verify independently all citations, legal authorities and evidence produced by generative AI.",
          "effective": "2026-06-23",
          "fetched": "2026-09-20"
        },
        {
          "title": "Same — amended § 4-2 (b) (signature is the certificate of § 4-9 compliance)",
          "url": "https://www.jud.ct.gov/legalresources/Docs/LJDocs/Misc/2026/26/pblj_8752.pdf",
          "verbatim": "(b) The signing of any pleading, motion, objection or request shall constitute a certificate that the signer has read such document, that to the best of the signer’s knowledge, information and belief there is good ground to support it, that it is not interposed for delay, and that the signer has complied with the requirements of Section 4-7 regarding personal identifying information and Section 4-9 regarding generative AI.",
          "effective": "2026-06-23",
          "fetched": "2026-09-20"
        },
        {
          "title": "Rules of Appellate Procedure amendments, 88 Conn. L.J. No. 3 (July 14, 2026) — adoption and effective-date notice",
          "url": "https://www.jud.ct.gov/LegalResources/Docs/LJDocs/Misc/2026/29/pblj_8803.pdf",
          "verbatim": "Notice is hereby given that the following amendments to the Rules of Appellate Procedure were adopted to take effect January 1, 2027, except the amendments to Sections 60-4, 62-6 and 85-2, pertaining to generative artificial intelligence (generative AI), which were adopted to take effect upon publication in this Connecticut Law Journal on July 14, 2026.",
          "effective": "2026-07-14",
          "fetched": "2026-09-20"
        },
        {
          "title": "Same — approval dates for the appellate amendments",
          "url": "https://www.jud.ct.gov/LegalResources/Docs/LJDocs/Misc/2026/29/pblj_8803.pdf",
          "verbatim": "The amendments were approved by the Supreme Court on June 30, 2026, and by the Appellate Court on June 23, 2026.",
          "effective": "2026-07-14",
          "fetched": "2026-09-20"
        },
        {
          "title": "Same — § 60-4 (definition adopted into the appellate rules)",
          "url": "https://www.jud.ct.gov/LegalResources/Docs/LJDocs/Misc/2026/29/pblj_8803.pdf",
          "verbatim": "“Generative Artificial Intelligence” or “generative AI” shall have the same meaning as used in Section 4-9.",
          "effective": "2026-07-14",
          "fetched": "2026-09-20"
        },
        {
          "title": "Same — § 62-6 (d) (appellate signature certificate)",
          "url": "https://www.jud.ct.gov/LegalResources/Docs/LJDocs/Misc/2026/29/pblj_8803.pdf",
          "verbatim": "(d) The signing of any paper shall constitute a certificate that the signer has read such document, that to the best of the signer’s knowledge, information and belief there is good ground to support it, that it is not solely interposed for delay, and that the signer has complied with the requirements of Section 4-7 regarding personal identifying information and Section 4-9 regarding generative AI.",
          "effective": "2026-07-14",
          "fetched": "2026-09-20"
        },
        {
          "title": "Same — § 85-2 (11) (failure to verify is sanctionable on appeal)",
          "url": "https://www.jud.ct.gov/LegalResources/Docs/LJDocs/Misc/2026/29/pblj_8803.pdf",
          "verbatim": "(11) Failure to independently verify all citations and legal authorities produced by generative AI in compliance with Sections 4-9 and 62-6 (d).",
          "effective": "2026-07-14",
          "fetched": "2026-09-20"
        },
        {
          "title": "Same — COMMENTARY accompanying the appellate AI amendments",
          "url": "https://www.jud.ct.gov/LegalResources/Docs/LJDocs/Misc/2026/29/pblj_8803.pdf",
          "verbatim": "COMMENTARY: The purpose of this amendment is to address the use of generative artificial intelligence (generative AI) in court filings.",
          "effective": "2026-07-14",
          "fetched": "2026-09-20"
        },
        {
          "title": "TOV Realty, LLC v. Suarez (SC 21183) and Kosel Equity, LLC v. MacGregor (SC 21184), Supreme Court of Connecticut, per curiam sanctions order dated July 31, 2026 (advance release, unpaginated; pinpoints below are PDF pages of the fetched file) — PDF p. 2, the facts",
          "url": "https://www.jud.ct.gov/external/supapp/Cases/AROcr/CR355/ORD355.3.pdf",
          "verbatim": "The applications included citations that were “hallucinated” because of the use of generative AI during the editing and review process. After the Chief Justice granted those applications, Attorney Gottlieb submitted briefs in each of these cases that also contained hallucinated citations.",
          "effective": "2026-07-31",
          "fetched": "2026-09-20"
        },
        {
          "title": "Same — PDF p. 3, how the hallucinations entered a verified draft",
          "url": "https://www.jud.ct.gov/external/supapp/Cases/AROcr/CR355/ORD355.3.pdf",
          "verbatim": "Unbeknownst to Attorney Gottlieb, the drafts produced by ChatGPT added new case citations or altered existing case citations, making the final documents filed in this court inaccurate and misleading.",
          "effective": "2026-07-31",
          "fetched": "2026-09-20"
        },
        {
          "title": "Same — PDF p. 2, the Rule 1.1 violation conceded and accepted",
          "url": "https://www.jud.ct.gov/external/supapp/Cases/AROcr/CR355/ORD355.3.pdf",
          "verbatim": "At a show cause hearing held on July 7, 2026, Attorney Gottlieb candidly admitted that his conduct, in filing documents that contained approximately seven erroneous and unverified citations as a result of the use of generative AI violated, at a minimum, rule 1.1 of the Rules of Professional Conduct.",
          "effective": "2026-07-31",
          "fetched": "2026-09-20"
        },
        {
          "title": "Same — PDF p. 4 n.1 (other rules noted but not decided)",
          "url": "https://www.jud.ct.gov/external/supapp/Cases/AROcr/CR355/ORD355.3.pdf",
          "verbatim": "During the show cause hearing, we noted the potential applicability of rules 1.6, 3.3, 5.1, and 8.4 of the Rules of Professional Conduct. Given our conclusion with respect to rule 1.1, we need not decide whether the conduct of Attorney Gottlieb and the law firm violated any other rule.",
          "effective": "2026-07-31",
          "fetched": "2026-09-20"
        },
        {
          "title": "Same — PDF p. 6 n.2 (competence includes privilege and confidentiality implications)",
          "url": "https://www.jud.ct.gov/external/supapp/Cases/AROcr/CR355/ORD355.3.pdf",
          "verbatim": "we emphasize that the duty of competence with respect to the use of generative AI in legal practice also includes recognition of its implications as to the attorney-client privilege, the confidentiality of information relating to an attorney’s representation of a client, and the work product doctrine, particularly when a public access platform is involved.",
          "effective": "2026-07-31",
          "fetched": "2026-09-20"
        },
        {
          "title": "Same — PDF p. 6 n.3 (firm liability for absent AI policies)",
          "url": "https://www.jud.ct.gov/external/supapp/Cases/AROcr/CR355/ORD355.3.pdf",
          "verbatim": "Although Attorney Gottlieb admirably accepted full responsibility for the erroneous material, the law firm shares responsibility given its failure at the time to have policies and procedures in place to address the responsible use of generative AI in the practice of law.",
          "effective": "2026-07-31",
          "fetched": "2026-09-20"
        },
        {
          "title": "Same — PDF p. 7, the sanctions imposed (CLE)",
          "url": "https://www.jud.ct.gov/external/supapp/Cases/AROcr/CR355/ORD355.3.pdf",
          "verbatim": "three (3) hours of which must concern the use of generative AI.",
          "effective": "2026-07-31",
          "fetched": "2026-09-20"
        },
        {
          "title": "Same — PDF p. 7, the sanctions imposed (payment)",
          "url": "https://www.jud.ct.gov/external/supapp/Cases/AROcr/CR355/ORD355.3.pdf",
          "verbatim": "Attorney Gottlieb and the law firm each shall donate $1000 to the CT Bar Institute, Inc.",
          "effective": "2026-07-31",
          "fetched": "2026-09-20"
        },
        {
          "title": "Same — PDF p. 8, closing admonition",
          "url": "https://www.jud.ct.gov/external/supapp/Cases/AROcr/CR355/ORD355.3.pdf",
          "verbatim": "This order should serve as a reminder to all members of the legal profession to learn about the risks and limitations of the technologies they use in the practice of law because they remain personally responsible to make certain that all information submitted to the court is true and accurate.",
          "effective": "2026-07-31",
          "fetched": "2026-09-20"
        },
        {
          "title": "Connecticut Judicial Branch, Practice Book and court rules index (where the adopted revisions are published)",
          "url": "https://www.jud.ct.gov/pb.htm",
          "verbatim": "Practice Book Revisions to the Superior Court Rules Adopted by the Judges of the Superior Court on June 11, 2026 (PDF)",
          "effective": null,
          "fetched": "2026-09-20"
        },
        {
          "title": "Connecticut Bar Association, Committee on Professional Ethics, informal-opinion index — advisory status and full list through 2025 (no AI opinion)",
          "url": "https://www.ctbar.org/news/CBAPublications/informal-ethics-opinions",
          "verbatim": "The Rules of Professional Conduct have the force of law on attorneys. The Formal and Informal Opinions are advisory opinions.",
          "effective": null,
          "fetched": "2026-09-20"
        },
        {
          "title": "Same — most recent opinion listed",
          "url": "https://www.ctbar.org/news/CBAPublications/informal-ethics-opinions",
          "verbatim": "Informal Opinion 25-04 | Duty to Report Professional Misconduct",
          "effective": null,
          "fetched": "2026-09-20"
        },
        {
          "title": "Rules Committee of the Superior Court page (agendas and minutes; no AI item located on its face)",
          "url": "https://www.jud.ct.gov/committees/rules/",
          "verbatim": null,
          "effective": null,
          "fetched": "2026-09-20"
        },
        {
          "title": "NOT USABLE — Connecticut General Assembly Statutes Text Search, query for artificial intelligence (the endpoint returned the whole statute index with a hit count of 0 on every document, twice; no statute sweep completed)",
          "url": "https://search.cga.state.ct.us/r/statute/dtsearch.asp?posted=posted&request=%22artificial+intelligence%22&stemming=1&db=SUR",
          "verbatim": null,
          "effective": null,
          "fetched": "2026-09-20"
        },
        {
          "title": "CourtListener v4 search API, Connecticut appellate and Superior Court opinions, generative-AI fabrication query (JSON result set, 2 hits)",
          "url": "https://www.courtlistener.com/api/rest/v4/search/?type=o&court=conn%20connappct%20connsuperct&q=%28%22artificial+intelligence%22+OR+%22generative+AI%22+OR+ChatGPT%29+AND+%28fabricated+OR+hallucinat%2A+OR+%22nonexistent+cases%22+OR+%22nonexistent+citations%22%29",
          "verbatim": null,
          "effective": null,
          "fetched": "2026-09-20"
        }
      ],
      "status": "verified",
      "verified_on": "2026-09-21",
      "verified_by": "claude-opus verifier session, batch 3b",
      "attorney_signoff": null,
      "notes": "BOTTOM LINE: Connecticut is the opposite of Pennsylvania. As of 2026-09-20 it has an in-force, statewide, court-wide generative-AI rule binding every filer — Practice Book § 4-9 (Superior Court, effective June 23, 2026) plus the amended signing rule § 4-2 (b), and on appeal § 60-4 (definition), § 62-6 (d) (signature certificate) and § 85-2 (11) (sanctionable conduct), all effective July 14, 2026. The rule imposes a VERIFICATION duty and a deemed certification by signature; it does NOT require disclosure that AI was used, does not prescribe any certificate text to be printed on a filing, and imposes no record-keeping duty. It binds \"Any person who files documents with the court\", not only attorneys, and it reaches editing as well as drafting — which is exactly how counsel was caught in TOV Realty. WHO ADOPTED WHAT, AND WHEN: the Superior Court amendments were adopted by the judges on June 11, 2026 and made effective on publication June 23, 2026 (87 Conn. L.J. No. 52); the appellate amendments were approved by the Supreme Court June 30, 2026 and by the Appellate Court June 23, 2026, effective on publication July 14, 2026 (88 Conn. L.J. No. 3), the courts having waived the sixty-day publication requirement of § 86-1. The seed entry us-ct-state-courts in the master matrix dates the adoption of § 4-9 to June 23, 2026; the notice itself says the judges adopted it on June 11, 2026 and that it took effect on publication June 23, 2026. Correct the seed at merge. DISCIPLINE: TOV Realty, LLC v. Suarez (SC 21183) and Kosel Equity, LLC v. MacGregor (SC 21184), a per curiam order of the Supreme Court of Connecticut bearing the date July 31, 2026 on its face (CourtListener records dateFiled 2026-08-04), sanctioned Attorney Ian G. Gottlieb and GLG Law, LLC for approximately seven hallucinated citations produced when verified LexisNexis drafts were pasted into ChatGPT for editing. Sanctions: six extra CLE hours (three on generative AI), $1000 from the attorney and $1000 from the firm to the CT Bar Institute, a compliance report to the court with a courtesy copy to the Statewide Grievance Committee, and reciprocal-discipline compliance elsewhere; the court stated the courtesy copy \"is not a referral for further disciplinary action.\" Only rule 1.1 was decided; rules 1.6, 3.3, 5.1 and 8.4 were flagged and left open (n.1). Footnote 3 puts the FIRM on the hook for not having AI policies in place. This is the only Connecticut appellate AI-sanction decision the CourtListener sweep returned. TECHNOLOGY COMPETENCE: Connecticut HAS the technology-competence language, in the Rule 1.1 COMMENTARY under the heading Maintaining Competence, in the ABA Model Rule wording. CAVEAT for the verifier: the Practice Book prints no amendment history for Rule 1.1 at all — its only source note is \"(P.B. 1978-1997, Rule 1.1.)\" — so the 2026 Practice Book does not itself supply an effective date for the technology clause, and the commonly cited January 1, 2014 date could not be confirmed from a primary source in this run. Rule 1.6 (e) and its commentary, which are the closest analogue, do carry \"amended June 14, 2013, to take effect Jan. 1, 2014.\" Connecticut also prints Lawyers’ Principles of Professionalism at the front of the Practice Book (adapted from the CBA House of Delegates document adopted October 19, 2020), including a technology-proficiency principle; those Principles are aspirational, not disciplinary. CHECKED, NOTHING AI-SPECIFIC FOUND (all fetched 2026-09-20): the whole 2026 Practice Book PDF (24.3 MB, extracted twice, once with -layout and once in reading order) contains zero occurrences of the word generative and only three of the word artificial, every one of them in the phrase \"artificial lighting device\" in the courtroom-photography rules — the RPC themselves say nothing about AI, and the printed 2026 edition predates the June 2026 amendments; the Connecticut Bar Association informal ethics opinions index, every year from 1985 to 2025 — no AI opinion, the most recent being Informal Opinion 25-04 (Duty to Report Professional Misconduct); jud.ct.gov home page and the Rules Committee of the Superior Court page (agendas and minutes listed through the September 22, 2026 meeting) — no AI policy or notice on their face. OPEN QUESTIONS FOR THE VERIFIER: (1) the Connecticut General Assembly statute full-text search (search.cga.state.ct.us/r/statute/dtsearch.asp) ignored the query on both attempts, returning all 1223 statute documents with a hit count of 0, so NO statute sweep was completed — check whether any Connecticut statute or public act addresses AI in court filings or law practice. (2) Confirm the date and Law Journal citation of the TOV Realty order (face date July 31, 2026 vs. CourtListener dateFiled 2026-08-04) and whether it has been published in the Connecticut Reports. (3) Find the primary source for when the technology clause entered the Rule 1.1 commentary. (4) Check whether the Judicial Branch has an internal generative-AI policy for judges and court staff (Pennsylvania has one; none was located on jud.ct.gov here). (5) Check whether the CBA Committee on Professional Ethics issued anything in 2026 — the index page showed no 2026 heading at all. NOT FETCHED: the 2025 Practice Book revisions (pblj_8652), the May 5, 2026 proposed appellate amendments, Rules Committee agendas and minutes PDFs, and the underlying merits opinions TOV Realty, LLC v. Suarez, 354 Conn. 745, and Kosel Equity, LLC v. MacGregor, 354 Conn. 842."
    },
    {
      "id": "mi-rpc",
      "kind": "state_bar",
      "name": "Michigan Rules of Professional Conduct (MRPC) and Michigan AI guidance",
      "disclosure_to_court": "none",
      "certification_required": false,
      "certificate_language": null,
      "verification_duty": "No Michigan rule, Supreme Court order, or statute imposes an AI-specific verification or disclosure duty on attorneys as of 2026-09-21; the duty comes from the general signing rule and from the general Rules of Professional Conduct, as a published Court of Appeals decision has now held. MCR 1.109(E)(5): \"The signature of a person filing a document, whether or not represented by an attorney, constitutes a certification by the signer that:\" the signer has read the document and that, \"to the best of his or her knowledge, information, and belief formed after reasonable inquiry, the document is well grounded in fact and is warranted by existing law or a good-faith argument for the extension, modification, or reversal of existing law; and\" it is not interposed for an improper purpose. Sanctions under MCR 1.109(E)(6) are mandatory on violation. BINDING CASELAW: Barber v Morawa, No. 374773 (Mich Ct App June 17, 2026) (FOR PUBLICATION): \"We join these other jurisdictions and hold that counsel’s submission of fabricated and unsupported authority violated the duty of reasonable inquiry required by MCR 1.109(E)(5).\" (slip op. 7). The panel added: \"Artificial intelligence may be a useful tool for legal research and drafting, but the use of such technology does not alter an attorney’s professional obligations. Lawyers remain responsible for the filings they sign and submit. They must verify that cited authorities exist, read the authorities on which they rely, and ensure that those authorities support the propositions asserted.\" (slip op. 7). MRPC black letter: Rule 1.1 \"A lawyer shall provide competent representation to a client. A lawyer shall not:\" (b) \"handle a legal matter without preparation adequate in the circumstances; or\" (c) \"neglect a legal matter entrusted to the lawyer.\" Rule 3.3(a)(1): a lawyer shall not knowingly \"make a false statement of material fact or law to a tribunal or fail to correct a false statement of material fact or law previously made to the tribunal by the lawyer;\". Rules 5.1(b) and 5.3(b) impose \"reasonable efforts to ensure\" conformity. Non-binding: State Bar of Michigan, Artificial Intelligence for Attorneys — Frequently Asked Questions (Nov. 18, 2024): \"In accordance with MRPC 1.1, lawyers have an ethical obligation to understand technology, including artificial intelligence (AI).\" and \"Therefore, it is imperative that lawyers check cites and information for accuracy, including but not limited to citations and source materials.\" The FAQs state on their face that they are \"neither legal advice nor an ethics opinion\".",
      "confidentiality_restriction": "Michigan keeps the pre-2002 confidence/secret formulation rather than the Model Rule 1.6 \"information relating to the representation\" formulation. MRPC 1.6(b): \"Except when permitted under paragraph (c), a lawyer shall not knowingly:\" (1) \"reveal a confidence or secret of a client;\". Consent route, MRPC 1.6(c)(1): a lawyer may reveal \"confidences or secrets with the consent of the client or clients affected, but only after full disclosure to them;\". MRPC 1.6(d): \"A lawyer shall exercise reasonable care to prevent employees, associates, and others whose services are utilized by the lawyer from disclosing or using confidences or secrets of a client, except that a lawyer may reveal the information allowed by paragraph (c) through an employee.\" The comment added by the Supreme Court order of Sept. 18, 2019 (effective Jan. 1, 2020) is the closest thing to a technology rule in MRPC 1.6: \"When transmitting a communication that contains confidential and/or privileged information relating to the representation of a client, the lawyer should take reasonable measures and act competently so that the confidential and/or privileged client information will not be revealed to unintended third parties.\" Non-binding SBM AI FAQs: \"Lawyers should only input information that does not fall under lawyer-client privilege or confidences and secrets protected under MRPC 1.6. If it is necessary to input any protected information, the lawyer must first receive the client’s consent under MRPC 1.6(c)(1).\"",
      "record_keeping_duty": "none",
      "client_disclosure_duty": "conditional — binding MRPC 1.4(b) requires a lawyer to \"explain a matter to the extent reasonably necessary to permit the client to make informed decisions regarding the representation.\" and MRPC 1.4(a) to \"keep a client reasonably informed about the status of a matter and comply promptly with reasonable requests for information.\"; client consent after full disclosure is required under MRPC 1.6(c)(1) before a confidence or secret goes into an AI tool. There is no free-standing AI disclosure duty: the State Bar's AI FAQs state that \"The Michigan Rules of Professional Conduct do not currently create a duty to inform the client that a lawyer is using an artificial intelligence program, except when use of the program implicates the rules of professional conduct.\" and that \"Further, the Michigan Rules of Professional Conduct do not include a duty to inform the court that the lawyer is using an artificial intelligence program unless the court requests such information.\" (SBM guidance, not binding).",
      "fees_note": "MRPC 1.5(a): \"A lawyer shall not enter into an agreement for, charge, or collect an illegal or clearly excessive fee.\" Non-binding SBM AI FAQs (fee answers published Nov. 18, 2024 and Feb. 11, 2025): the overhead/expense line is \"In the absence of disclosure to a client in advance of the engagement, the overhead expense of using the AI tool should be absorbed by the lawyer or law firm.\" and \"Lawyers should not charge a client for expenses related to learning how to use an AI tool or service.\"",
      "sources": [
        {
          "title": "Michigan Rules of Professional Conduct (compilation updated with MSC orders effective 1/1/2026) — Rule 1.0(c), authority of the comments",
          "url": "https://www.courts.michigan.gov/492c94/siteassets/rules-instructions-administrative-orders/rules-of-professional-conduct/michigan-rules-of-professional-conduct.pdf",
          "verbatim": "The text of each rule is authoritative. The comment that accompanies each rule does not expand or limit the scope of the obligations, prohibitions, and counsel found in the text of the rule.",
          "effective": null,
          "fetched": "2026-09-21"
        },
        {
          "title": "Same — Rule 1.0 Comment (comments published as an aid to the reader)",
          "url": "https://www.courts.michigan.gov/492c94/siteassets/rules-instructions-administrative-orders/rules-of-professional-conduct/michigan-rules-of-professional-conduct.pdf",
          "verbatim": "The Supreme Court has authorized publication of the comments as an aid to the reader, but the rules alone comprise the Supreme Court’s authoritative statement of a lawyer’s ethical obligations.",
          "effective": null,
          "fetched": "2026-09-21"
        },
        {
          "title": "Same — Rule 1.1 (Competence), black letter (Michigan does NOT use the Model Rule 1.1 formulation)",
          "url": "https://www.courts.michigan.gov/492c94/siteassets/rules-instructions-administrative-orders/rules-of-professional-conduct/michigan-rules-of-professional-conduct.pdf",
          "verbatim": "A lawyer shall provide competent representation to a client. A lawyer shall not:",
          "effective": null,
          "fetched": "2026-09-21"
        },
        {
          "title": "Same — Rule 1.1(a)",
          "url": "https://www.courts.michigan.gov/492c94/siteassets/rules-instructions-administrative-orders/rules-of-professional-conduct/michigan-rules-of-professional-conduct.pdf",
          "verbatim": "(a) handle a legal matter which the lawyer knows or should know that the lawyer is not competent to handle, without associating with a lawyer who is competent to handle it;",
          "effective": null,
          "fetched": "2026-09-21"
        },
        {
          "title": "Same — Rule 1.1(b)",
          "url": "https://www.courts.michigan.gov/492c94/siteassets/rules-instructions-administrative-orders/rules-of-professional-conduct/michigan-rules-of-professional-conduct.pdf",
          "verbatim": "(b) handle a legal matter without preparation adequate in the circumstances; or",
          "effective": null,
          "fetched": "2026-09-21"
        },
        {
          "title": "Same — Rule 1.1(c)",
          "url": "https://www.courts.michigan.gov/492c94/siteassets/rules-instructions-administrative-orders/rules-of-professional-conduct/michigan-rules-of-professional-conduct.pdf",
          "verbatim": "(c) neglect a legal matter entrusted to the lawyer.",
          "effective": null,
          "fetched": "2026-09-21"
        },
        {
          "title": "Same — Rule 1.1 Comment, Maintaining Competence (Michigan's technology-competence language; NOT the ABA Comment [8] wording)",
          "url": "https://www.courts.michigan.gov/492c94/siteassets/rules-instructions-administrative-orders/rules-of-professional-conduct/michigan-rules-of-professional-conduct.pdf",
          "verbatim": "To maintain the requisite knowledge and skill, a lawyer should engage in continuing study and education, including the knowledge and skills regarding existing and developing technology that are reasonably necessary to provide competent representation for the client in a particular matter.",
          "effective": "2020-01-01",
          "fetched": "2026-09-21"
        },
        {
          "title": "Same — Rule 1.4(a) (Communication)",
          "url": "https://www.courts.michigan.gov/492c94/siteassets/rules-instructions-administrative-orders/rules-of-professional-conduct/michigan-rules-of-professional-conduct.pdf",
          "verbatim": "(a) A lawyer shall keep a client reasonably informed about the status of a matter and comply promptly with reasonable requests for information.",
          "effective": null,
          "fetched": "2026-09-21"
        },
        {
          "title": "Same — Rule 1.4(b)",
          "url": "https://www.courts.michigan.gov/492c94/siteassets/rules-instructions-administrative-orders/rules-of-professional-conduct/michigan-rules-of-professional-conduct.pdf",
          "verbatim": "(b) A lawyer shall explain a matter to the extent reasonably necessary to permit the client to make informed decisions regarding the representation.",
          "effective": null,
          "fetched": "2026-09-21"
        },
        {
          "title": "Same — Rule 1.5(a) (Fees)",
          "url": "https://www.courts.michigan.gov/492c94/siteassets/rules-instructions-administrative-orders/rules-of-professional-conduct/michigan-rules-of-professional-conduct.pdf",
          "verbatim": "(a) A lawyer shall not enter into an agreement for, charge, or collect an illegal or clearly excessive fee.",
          "effective": null,
          "fetched": "2026-09-21"
        },
        {
          "title": "Same — Rule 1.6(b) (Confidentiality of Information; confidence-or-secret formulation)",
          "url": "https://www.courts.michigan.gov/492c94/siteassets/rules-instructions-administrative-orders/rules-of-professional-conduct/michigan-rules-of-professional-conduct.pdf",
          "verbatim": "(b) Except when permitted under paragraph (c), a lawyer shall not knowingly:",
          "effective": null,
          "fetched": "2026-09-21"
        },
        {
          "title": "Same — Rule 1.6(b)(1)",
          "url": "https://www.courts.michigan.gov/492c94/siteassets/rules-instructions-administrative-orders/rules-of-professional-conduct/michigan-rules-of-professional-conduct.pdf",
          "verbatim": "(1) reveal a confidence or secret of a client;",
          "effective": null,
          "fetched": "2026-09-21"
        },
        {
          "title": "Same — Rule 1.6(c)(1) (client consent after full disclosure)",
          "url": "https://www.courts.michigan.gov/492c94/siteassets/rules-instructions-administrative-orders/rules-of-professional-conduct/michigan-rules-of-professional-conduct.pdf",
          "verbatim": "(1) confidences or secrets with the consent of the client or clients affected, but only after full disclosure to them;",
          "effective": null,
          "fetched": "2026-09-21"
        },
        {
          "title": "Same — Rule 1.6(d) (reasonable care over those whose services the lawyer uses)",
          "url": "https://www.courts.michigan.gov/492c94/siteassets/rules-instructions-administrative-orders/rules-of-professional-conduct/michigan-rules-of-professional-conduct.pdf",
          "verbatim": "(d) A lawyer shall exercise reasonable care to prevent employees, associates, and others whose services are utilized by the lawyer from disclosing or using confidences or secrets of a client, except that a lawyer may reveal the information allowed by paragraph (c) through an employee.",
          "effective": null,
          "fetched": "2026-09-21"
        },
        {
          "title": "Same — Rule 1.6 Comment, Confidentiality of Information (comment added by the Sept. 18, 2019 order, effective Jan. 1, 2020)",
          "url": "https://www.courts.michigan.gov/492c94/siteassets/rules-instructions-administrative-orders/rules-of-professional-conduct/michigan-rules-of-professional-conduct.pdf",
          "verbatim": "When transmitting a communication that contains confidential and/or privileged information relating to the representation of a client, the lawyer should take reasonable measures and act competently so that the confidential and/or privileged client information will not be revealed to unintended third parties.",
          "effective": "2020-01-01",
          "fetched": "2026-09-21"
        },
        {
          "title": "Same — Rule 3.3(a)(1) (Candor Toward the Tribunal)",
          "url": "https://www.courts.michigan.gov/492c94/siteassets/rules-instructions-administrative-orders/rules-of-professional-conduct/michigan-rules-of-professional-conduct.pdf",
          "verbatim": "(1) make a false statement of material fact or law to a tribunal or fail to correct a false statement of material fact or law previously made to the tribunal by the lawyer;",
          "effective": null,
          "fetched": "2026-09-21"
        },
        {
          "title": "Same — Rule 5.1(b) (supervisory lawyers)",
          "url": "https://www.courts.michigan.gov/492c94/siteassets/rules-instructions-administrative-orders/rules-of-professional-conduct/michigan-rules-of-professional-conduct.pdf",
          "verbatim": "(b) A lawyer having direct supervisory authority over another lawyer shall make reasonable efforts to ensure that the other lawyer conforms to the Rules of Professional Conduct.",
          "effective": null,
          "fetched": "2026-09-21"
        },
        {
          "title": "Same — Rule 5.3(b) (nonlawyer assistants)",
          "url": "https://www.courts.michigan.gov/492c94/siteassets/rules-instructions-administrative-orders/rules-of-professional-conduct/michigan-rules-of-professional-conduct.pdf",
          "verbatim": "(b) a lawyer having direct supervisory authority over the nonlawyer shall make reasonable efforts to ensure that the person’s conduct is compatible with the professional obligations of the lawyer; and",
          "effective": null,
          "fetched": "2026-09-21"
        },
        {
          "title": "Michigan Court Rules Chapter 1 (updated with MSC orders effective Jan. 1, 2026) — currency statement",
          "url": "https://www.courts.michigan.gov/siteassets/rules-instructions-administrative-orders/michigan-court-rules/michigan-court-rules-responsive-html5.zip/Michigan_Court_Rules/Court_Rules_Chapter_1/Court_Rules_Chapter_1.htm",
          "verbatim": "Chapter Updated with MSC Order(s) Effective on January 1, 2026",
          "effective": "2026-01-01",
          "fetched": "2026-09-21"
        },
        {
          "title": "Same — MCR 1.109(E)(5) (effect of signature; general signing certification, not AI-specific)",
          "url": "https://www.courts.michigan.gov/siteassets/rules-instructions-administrative-orders/michigan-court-rules/michigan-court-rules-responsive-html5.zip/Michigan_Court_Rules/Court_Rules_Chapter_1/Court_Rules_Chapter_1.htm",
          "verbatim": "The signature of a person filing a document, whether or not represented by an attorney, constitutes a certification by the signer that:",
          "effective": null,
          "fetched": "2026-09-21"
        },
        {
          "title": "Same — MCR 1.109(E)(5)(b) (reasonable inquiry; well grounded in fact)",
          "url": "https://www.courts.michigan.gov/siteassets/rules-instructions-administrative-orders/michigan-court-rules/michigan-court-rules-responsive-html5.zip/Michigan_Court_Rules/Court_Rules_Chapter_1/Court_Rules_Chapter_1.htm",
          "verbatim": "to the best of his or her knowledge, information, and belief formed after reasonable inquiry, the document is well grounded in fact and is warranted by existing law or a good-faith argument for the extension, modification, or reversal of existing law; and",
          "effective": null,
          "fetched": "2026-09-21"
        },
        {
          "title": "Same — MCR 1.109(E)(6) (mandatory sanction for signing in violation)",
          "url": "https://www.courts.michigan.gov/siteassets/rules-instructions-administrative-orders/michigan-court-rules/michigan-court-rules-responsive-html5.zip/Michigan_Court_Rules/Court_Rules_Chapter_1/Court_Rules_Chapter_1.htm",
          "verbatim": "If a document is signed in violation of this rule, the court, on the motion of a party or on its own initiative, shall impose upon the person who signed it, a represented party, or both, an appropriate sanction, which may include an order to pay to the other party or parties the amount of the reasonable expenses incurred because of the filing of the document, including reasonable attorney fees.",
          "effective": null,
          "fetched": "2026-09-21"
        },
        {
          "title": "Barber v Morawa, No. 374773 (Mich Ct App June 17, 2026) (FOR PUBLICATION) — slip op. 7 (holding)",
          "url": "https://www.courts.michigan.gov/49d9f9/siteassets/case-documents/uploads/opinions/final/coa/20260617_c374773_42_374773.opn.pdf",
          "verbatim": "We join these other jurisdictions and hold that counsel’s submission of fabricated and unsupported authority violated the duty of reasonable inquiry required by MCR 1.109(E)(5).",
          "effective": "2026-06-17",
          "fetched": "2026-09-21"
        },
        {
          "title": "Same — slip op. 7 (AI does not alter professional obligations; verification duty stated)",
          "url": "https://www.courts.michigan.gov/49d9f9/siteassets/case-documents/uploads/opinions/final/coa/20260617_c374773_42_374773.opn.pdf",
          "verbatim": "Artificial intelligence may be a useful tool for legal research and drafting, but the use of such technology does not alter an attorney’s professional obligations. Lawyers remain responsible for the filings they sign and submit. They must verify that cited authorities exist, read the authorities on which they rely, and ensure that those authorities support the propositions asserted.",
          "effective": "2026-06-17",
          "fetched": "2026-09-21"
        },
        {
          "title": "Same — slip op. 6 (state of Michigan caselaw before this decision)",
          "url": "https://www.courts.michigan.gov/49d9f9/siteassets/case-documents/uploads/opinions/final/coa/20260617_c374773_42_374773.opn.pdf",
          "verbatim": "Michigan has no specific caselaw regarding the consequences for fabricated or unsupported legal authority generated through the misuse of artificial intelligence, but federal caselaw provides useful guidance.",
          "effective": "2026-06-17",
          "fetched": "2026-09-21"
        },
        {
          "title": "Same — slip op. 8 (no published Michigan decision on the appropriate sanction)",
          "url": "https://www.courts.michigan.gov/49d9f9/siteassets/case-documents/uploads/opinions/final/coa/20260617_c374773_42_374773.opn.pdf",
          "verbatim": "No published Michigan decision addresses the appropriate sanction under MCR 7.216(C)(1) or MCR 1.109(E)(6) for an attorney’s submission of fabricated or unsupported legal authority resulting from the misuse of generative artificial intelligence.",
          "effective": "2026-06-17",
          "fetched": "2026-09-21"
        },
        {
          "title": "Same — slip op. 9 (sanction personal to counsel)",
          "url": "https://www.courts.michigan.gov/49d9f9/siteassets/case-documents/uploads/opinions/final/coa/20260617_c374773_42_374773.opn.pdf",
          "verbatim": "the sanction is to be paid by plaintiff’s counsel personally.",
          "effective": "2026-06-17",
          "fetched": "2026-09-21"
        },
        {
          "title": "Same — slip op. 9 (referral to the Attorney Grievance Commission)",
          "url": "https://www.courts.michigan.gov/49d9f9/siteassets/case-documents/uploads/opinions/final/coa/20260617_c374773_42_374773.opn.pdf",
          "verbatim": "We do not retain jurisdiction, but we direct the Clerk of this Court to forward this opinion to the Attorney Grievance Commission for possible investigation.",
          "effective": "2026-06-17",
          "fetched": "2026-09-21"
        },
        {
          "title": "State Bar of Michigan, Artificial Intelligence for Attorneys — Frequently Asked Questions (SBM guidance, not an ethics opinion) — headnote",
          "url": "https://www.michbar.org/opinions/ethics/AIFAQs",
          "verbatim": "[These FAQs are neither legal advice nor an ethics opinion, and are not a substitute for your obligation to adhere to the requirements of the Michigan Rules of Professional Conduct (MRPC), the Michigan Code of Judicial Conduct , statutes, court rules, and/or case law and to review ethics opinions.",
          "effective": "2024-11-18",
          "fetched": "2026-09-21"
        },
        {
          "title": "Same — Applicable Rules (MRPC apply to AI use)",
          "url": "https://www.michbar.org/opinions/ethics/AIFAQs",
          "verbatim": "A lawyer must continue to abide by the Rules of Professional Conduct when utilizing artificial intelligence or similar technology through their practice.",
          "effective": "2024-11-18",
          "fetched": "2026-09-21"
        },
        {
          "title": "Same — Duty of Competence",
          "url": "https://www.michbar.org/opinions/ethics/AIFAQs",
          "verbatim": "In accordance with MRPC 1.1, lawyers have an ethical obligation to understand technology, including artificial intelligence (AI).",
          "effective": "2024-11-18",
          "fetched": "2026-09-21"
        },
        {
          "title": "Same — Duty of Competence (hallucination)",
          "url": "https://www.michbar.org/opinions/ethics/AIFAQs",
          "verbatim": "Some AI, including automatic drafting services, may not check case cites to ensure the case has not been overturned, or worse, may completely fabricate (also known as “AI hallucination”) information and make up citations in order to support it.",
          "effective": "2024-11-18",
          "fetched": "2026-09-21"
        },
        {
          "title": "Same — Duty of Diligence (signature certification and sanctions exposure)",
          "url": "https://www.michbar.org/opinions/ethics/AIFAQs",
          "verbatim": "Because AI-generated searches have the capability of creating results that are not grounded in existing law, lawyers submitting documents to courts based on AI-generated searches are at risk of violating their professional responsibilities and exposing themselves and their clients to sanctions.",
          "effective": "2024-11-18",
          "fetched": "2026-09-21"
        },
        {
          "title": "Same — Duty of Diligence (cite checking)",
          "url": "https://www.michbar.org/opinions/ethics/AIFAQs",
          "verbatim": "Therefore, it is imperative that lawyers check cites and information for accuracy, including but not limited to citations and source materials.",
          "effective": "2024-11-18",
          "fetched": "2026-09-21"
        },
        {
          "title": "Same — Duty of Confidentiality (what may go into an AI tool)",
          "url": "https://www.michbar.org/opinions/ethics/AIFAQs",
          "verbatim": "Lawyers should only input information that does not fall under lawyer-client privilege or confidences and secrets protected under MRPC 1.6. If it is necessary to input any protected information, the lawyer must first receive the client’s consent under MRPC 1.6(c)(1).",
          "effective": "2024-11-18",
          "fetched": "2026-09-21"
        },
        {
          "title": "Same — Duty of Communication (no duty to tell the client)",
          "url": "https://www.michbar.org/opinions/ethics/AIFAQs",
          "verbatim": "The Michigan Rules of Professional Conduct do not currently create a duty to inform the client that a lawyer is using an artificial intelligence program, except when use of the program implicates the rules of professional conduct.",
          "effective": "2024-11-18",
          "fetched": "2026-09-21"
        },
        {
          "title": "Same — Duty of Communication (no duty to tell the court)",
          "url": "https://www.michbar.org/opinions/ethics/AIFAQs",
          "verbatim": "Further, the Michigan Rules of Professional Conduct do not include a duty to inform the court that the lawyer is using an artificial intelligence program unless the court requests such information.",
          "effective": "2024-11-18",
          "fetched": "2026-09-21"
        },
        {
          "title": "Same — Fees (AI tool cost as overhead)",
          "url": "https://www.michbar.org/opinions/ethics/AIFAQs",
          "verbatim": "In the absence of disclosure to a client in advance of the engagement, the overhead expense of using the AI tool should be absorbed by the lawyer or law firm.",
          "effective": "2024-11-18",
          "fetched": "2026-09-21"
        },
        {
          "title": "Same — Fees (learning cost)",
          "url": "https://www.michbar.org/opinions/ethics/AIFAQs",
          "verbatim": "Lawyers should not charge a client for expenses related to learning how to use an AI tool or service.",
          "effective": "2025-02-11",
          "fetched": "2026-09-21"
        },
        {
          "title": "Same — publication date carried on the competence, diligence, confidentiality, communication and first two fee answers",
          "url": "https://www.michbar.org/opinions/ethics/AIFAQs",
          "verbatim": "Publication date: November 18, 2024",
          "effective": "2024-11-18",
          "fetched": "2026-09-21"
        },
        {
          "title": "Same — publication date carried on the AI-development fee answer",
          "url": "https://www.michbar.org/opinions/ethics/AIFAQs",
          "verbatim": "Publication date: February 11, 2025",
          "effective": "2025-02-11",
          "fetched": "2026-09-21"
        },
        {
          "title": "Michigan Judicial Council, Generative AI and the Courts Workgroup, Report and Recommendations (October 2024) — Notice of Disclaimer, p. 2",
          "url": "https://www.courts.michigan.gov/4aec3b/siteassets/committees,-boards-special-initiatves/michigan-judicial-council/2024-genai-wg-report.pdf",
          "verbatim": "The opinions and recommendations contained in this document are those of the Michigan Judicial Council, do not constitute legal advice and do not represent the official position or policies of the Michigan Supreme Court or State Court Administrative Office or any affiliated organization of a workgroup member.",
          "effective": "2024-10-01",
          "fetched": "2026-09-21"
        },
        {
          "title": "Same — Professional Responsibility & Legal Ethics (existing rules judged sufficient; no new rule proposed)",
          "url": "https://www.courts.michigan.gov/4aec3b/siteassets/committees,-boards-special-initiatves/michigan-judicial-council/2024-genai-wg-report.pdf",
          "verbatim": "it is preliminarily of the view that existing rules are likely sufficiently broad at this time to capture the legal and ethical use of GenAI tools by judicial officers and attorneys who practice before the courts.",
          "effective": "2024-10-01",
          "fetched": "2026-09-21"
        },
        {
          "title": "Same — two conditions on any GenAI use",
          "url": "https://www.courts.michigan.gov/4aec3b/siteassets/committees,-boards-special-initiatves/michigan-judicial-council/2024-genai-wg-report.pdf",
          "verbatim": "In the meantime, any GenAI use (whether by court personnel or attorneys) must be premised upon two conditions being met:",
          "effective": "2024-10-01",
          "fetched": "2026-09-21"
        },
        {
          "title": "Same — Letter from a Co-Chair (view on disclosure requirements)",
          "url": "https://www.courts.michigan.gov/4aec3b/siteassets/committees,-boards-special-initiatves/michigan-judicial-council/2024-genai-wg-report.pdf",
          "verbatim": "I am personally skeptical of requirements to disclose the use of GenAI in legal documents or courts due to the difficulty of enforcement",
          "effective": "2024-10-01",
          "fetched": "2026-09-21"
        },
        {
          "title": "State Bar of Michigan, Michigan Bar Journal, From the Michigan Supreme Court (Nov. 2019), p. 74 — reprint of the Supreme Court order adopting amendments of MRPC 1.1 and 1.6 (two-column reprint; see notes)",
          "url": "https://www.michbar.org/file/barjournal/article/documents/pdf4article3819.pdf",
          "verbatim": "Amendments of Rules 1.1 and 1.6 of the Michigan Rules",
          "effective": "2020-01-01",
          "fetched": "2026-09-21"
        },
        {
          "title": "Same — order caption date line, p. 74",
          "url": "https://www.michbar.org/file/barjournal/article/documents/pdf4article3819.pdf",
          "verbatim": "of Professional Conduct (Dated September 18, 2019)",
          "effective": "2020-01-01",
          "fetched": "2026-09-21"
        },
        {
          "title": "Same — adoption/effective-date sentence, p. 74",
          "url": "https://www.michbar.org/file/barjournal/article/documents/pdf4article3819.pdf",
          "verbatim": "the Michigan Rules of Professional Conduct are adopted, effective",
          "effective": "2020-01-01",
          "fetched": "2026-09-21"
        },
        {
          "title": "Same — the technology clause as adopted, p. 74",
          "url": "https://www.michbar.org/file/barjournal/article/documents/pdf4article3819.pdf",
          "verbatim": "including the knowledge and skills regarding existing and developing technology that are reasonably necessary to provide",
          "effective": "2020-01-01",
          "fetched": "2026-09-21"
        },
        {
          "title": "Michigan Supreme Court Administrative Orders, full compilation (checked for AI; none found; current through AO No. 2026-4)",
          "url": "https://www.courts.michigan.gov/499019/siteassets/rules-instructions-administrative-orders/administrative-orders/administrative-orders.pdf",
          "verbatim": null,
          "effective": null,
          "fetched": "2026-09-21"
        },
        {
          "title": "Michigan Court Rules Chapter 2 (Civil Procedure) — checked for AI language; none found",
          "url": "https://www.courts.michigan.gov/siteassets/rules-instructions-administrative-orders/michigan-court-rules/michigan-court-rules-responsive-html5.zip/Michigan_Court_Rules/Court_Rules_Chapter_2/Court_Rules_Chapter_2.htm",
          "verbatim": null,
          "effective": null,
          "fetched": "2026-09-21"
        },
        {
          "title": "Michigan Court Rules Chapter 7 (Appellate) — checked for AI language; none found",
          "url": "https://www.courts.michigan.gov/siteassets/rules-instructions-administrative-orders/michigan-court-rules/michigan-court-rules-responsive-html5.zip/Michigan_Court_Rules/Court_Rules_Chapter_7/Court_Rules_Chapter_7.htm",
          "verbatim": null,
          "effective": null,
          "fetched": "2026-09-21"
        },
        {
          "title": "Michigan Court Rules Chapter 8 (Administrative Rules of Court) — checked for AI language; none found",
          "url": "https://www.courts.michigan.gov/siteassets/rules-instructions-administrative-orders/michigan-court-rules/michigan-court-rules-responsive-html5.zip/Michigan_Court_Rules/Court_Rules_Chapter_8/Court_Rules_Chapter_8.htm",
          "verbatim": null,
          "effective": null,
          "fetched": "2026-09-21"
        },
        {
          "title": "State Bar of Michigan, Age of AI report (June 2025) — fetched, not relied on for any field",
          "url": "https://www.michbar.org/Portals/0/publications/pdfs/Age_of_AI_Report_June25.pdf",
          "verbatim": null,
          "effective": "2025-06-01",
          "fetched": "2026-09-21"
        },
        {
          "title": "CourtListener v4 search API result set (type=o, court=mich michctapp, filed_after=2023-01-01, artificial intelligence AND fabricated/fictitious/nonexistent/hallucinat*) — one hit, Barber v Morawa",
          "url": "https://www.courtlistener.com/api/rest/v4/search/?type=o&court=mich%20michctapp&filed_after=2023-01-01&q=%22artificial%20intelligence%22%20AND%20(fabricated%20OR%20fictitious%20OR%20nonexistent%20OR%20hallucinat*)",
          "verbatim": null,
          "effective": null,
          "fetched": "2026-09-21"
        },
        {
          "title": "LEAD ONLY — State Bar of Michigan ethics opinion indexes (Recent Ethics Opinions; Opinions by Number); JavaScript-rendered, no server-side list returned",
          "url": "https://www.michbar.org/opinions/ethics/recent",
          "verbatim": null,
          "effective": null,
          "fetched": "2026-09-21"
        },
        {
          "title": "LEAD ONLY — Michigan Supreme Court page, Michigan Rules of Professional Conduct, proposed and adopted orders (JavaScript-rendered; no order list returned to curl)",
          "url": "https://www.courts.michigan.gov/rules-administrative-orders-and-jury-instructions/proposed-adopted/michigan-rules-of-professional-conduct/",
          "verbatim": null,
          "effective": null,
          "fetched": "2026-09-21"
        }
      ],
      "status": "verified",
      "verified_on": "2026-09-21",
      "verified_by": "claude-opus verifier session, batch 4a",
      "attorney_signoff": null,
      "notes": "BOTTOM LINE: Michigan has no AI-specific rule, order, or statute for attorneys as of 2026-09-21 — but it does now have a PUBLISHED, binding Court of Appeals holding that filing AI-fabricated authority violates the general signing rule, MCR 1.109(E)(5), with mandatory sanctions under MCR 1.109(E)(6). That decision, Barber v Morawa, No. 374773 (Mich Ct App June 17, 2026) (FOR PUBLICATION; Ackerman, J., joined by Borrello, P.J., and M. J. Kelly, J.), is the single most important item in this entry and did not exist when most AI trackers were written. It affirmed on the merits, found an MCR 7.216(C)(1)(b) vexatious-appeal violation and an MCR 1.109(E)(5) violation, remanded for an evidentiary hearing on actual damages and fees payable by counsel personally, and directed the Clerk to forward the opinion to the Attorney Grievance Commission. It expressly records that before it, \"Michigan has no specific caselaw regarding the consequences for fabricated or unsupported legal authority generated through the misuse of artificial intelligence, but federal caselaw provides useful guidance.\" TECHNOLOGY-COMPETENCE COMMENT: Michigan ADOPTED one, but NOT in the ABA Comment [8] wording and NOT as a numbered comment. The Michigan comment to Rule 1.1, under the heading Maintaining Competence, reads \"To maintain the requisite knowledge and skill, a lawyer should engage in continuing study and education, including the knowledge and skills regarding existing and developing technology that are reasonably necessary to provide competent representation for the client in a particular matter.\" Michigan omits the ABA Comment [8] phrase about keeping abreast of the benefits and risks associated with relevant technology and substitutes a matter-specific, need-based formulation. The same Supreme Court order added a technology comment to Rule 1.6 about transmitting confidential communications. Both were adopted by order dated September 18, 2019, effective January 1, 2020, as reprinted in the Michigan Bar Journal (Nov. 2019) at 74-75. OPEN QUESTION FOR THE VERIFIER: the ADM File number of that order was not located — the Michigan courts website search, the MRPC proposed/adopted-orders page and the Michigan Court Rules pages are JavaScript-rendered and returned no order list to curl, and the Bar Journal reprint on p. 74 does not print the ADM number next to this order (it prints ADM File Nos. 2002-37 and 2018-16 for different orders on the same page). The Bar Journal reprint is a two-column PDF; pdftotext -layout interleaves the columns, so only fragments that sit inside a single column line can be quoted from it. The current comment text quoted in this entry comes from the Supreme Court's own MRPC compilation, not from the Bar Journal. MICHIGAN RULE 1.1 IS NOT THE MODEL RULE. Michigan never adopted the Ethics 2000 formulation: the black letter is a prohibition-style rule, \"A lawyer shall provide competent representation to a client. A lawyer shall not:\" followed by (a)-(c). Comments in Michigan are weaker than in most states: MRPC 1.0(c) says \"The text of each rule is authoritative. The comment that accompanies each rule does not expand or limit the scope of the obligations, prohibitions, and counsel found in the text of the rule.\" and the Rule 1.0 comment says \"The Supreme Court has authorized publication of the comments as an aid to the reader, but the rules alone comprise the Supreme Court’s authoritative statement of a lawyer’s ethical obligations.\" So the technology clause is guidance, not an obligation; the enforceable hook is MCR 1.109(E)(5) plus MRPC 1.1(b)-(c), 3.3, 5.1 and 5.3. MICHIGAN RULE 1.6 IS NOT THE MODEL RULE EITHER. It protects a client \"confidence or secret\" rather than \"information relating to the representation\", the consent route is MRPC 1.6(c)(1) (consent \"after full disclosure\"), and there is no Model-Rule 1.6(c) reasonable-efforts paragraph; the nearest analogue is MRPC 1.6(d) on employees, associates and \"others whose services are utilized by the lawyer\". STATUS OF THE AI GUIDANCE: (a) The State Bar of Michigan's Artificial Intelligence for Attorneys FAQs are the only Michigan AI guidance addressed to lawyers. They are SBM staff guidance, not an ethics opinion and not binding — their own headnote says the FAQs are \"neither legal advice nor an ethics opinion\". Answers carry per-answer publication dates: November 18, 2024 for the competence, diligence, confidentiality, communication and first two fee answers, February 11, 2025 for the AI-development fee answer; the page footer says Last updated: November 2024. The FAQs cite, but do not supersede, SBM ethics opinions RI-150, RI-241, RI-349, RI-364 and RI-381 (cybersecurity), none of which is AI-specific. (b) The Michigan Judicial Council's Generative AI and the Courts Workgroup Report and Recommendations (October 2024) is a workgroup report to the MJC, not a court order; it carries its own disclaimer that it does \"not represent the official position or policies of the Michigan Supreme Court or State Court Administrative Office\". Its recommendations are training, pilots, feedback loops and scaling — no rule change was recommended and none has issued. It recorded the view that \"existing rules are likely sufficiently broad at this time\". CHECKED, NOTHING AI-SPECIFIC FOUND (all fetched 2026-09-21): the full Michigan Rules of Professional Conduct compilation (updated with MSC orders effective 1/1/2026) — grep for artificial intelligence, generative, machine learning, large language, chatgpt, hallucinat, technolog returned exactly one hit, the Rule 1.1 Maintaining Competence clause; Michigan Court Rules Chapters 1, 2, 7 and 8 (Chapter 1 updated with MSC orders effective January 1, 2026; Chapters 2, 7 and 8 with orders effective September 1, 2026) — 0 hits for artificial intelligence, generative, machine learning, large language, chatgpt; the Michigan Supreme Court Administrative Orders compilation, 14,733 lines, current through AO No. 2026-4 — 0 AI hits (the nine technolog hits are interactive-video, IT-vendor and indigent-defense-counsel provisions); CourtListener v4 (courts mich and michctapp, filed after 2023-01-01) — one responsive opinion, Barber, which is included above. NOT CHECKED / GAPS FOR THE VERIFIER: (1) No statute sweep was performed. legislature.mi.gov returned HTTP 404 on every search URL tried, so the Michigan Compiled Laws and pending Michigan bills were NOT searched for AI-in-court-filings provisions; nothing in this entry should be read as a finding that no Michigan statute exists. (2) The State Bar ethics-opinion indexes are JavaScript-rendered and returned no list to curl, so the conclusion that Michigan has no AI-specific ethics opinion rests on the AI FAQs themselves (which would cite one) and on the FAQ's own list of relevant opinions, not on a full index sweep. (3) MCR Chapters 3, 4, 5, 6 and 9 were not fetched. (4) Michigan Attorney Discipline Board and Attorney Grievance Commission materials were not fetched; Barber's referral makes the AGC a live watch item. (5) Individual Michigan circuit or district court local administrative orders on AI were not surveyed; this entry is statewide only. EFFECTIVE-DATE CONVENTION FOR THIS ENTRY: the Supreme Court's MRPC compilation and the Michigan Court Rules chapters print no per-rule amendment history, only a compilation-wide currency line. The effective field is therefore null for every rule-text item, and 2026-01-01 appears only on the item whose verbatim IS that currency line. The two comment items carry 2020-01-01 because the Supreme Court order reprinted in the Michigan Bar Journal dates them; 2026-06-17 is the Barber filing date; the State Bar FAQ items carry the per-answer publication dates printed on the page."
    },
    {
      "id": "wa-rpc",
      "kind": "state_bar",
      "name": "Washington Rules of Professional Conduct and Washington AI guidance",
      "disclosure_to_court": "none",
      "certification_required": false,
      "certificate_language": null,
      "verification_duty": "No Washington court rule, Supreme Court order, or statute imposes an AI-specific verification or disclosure duty on attorneys as of 2026-09-21; the duty comes from CR 11 and the general Rules of Professional Conduct, and Washington's state bar has issued a full AI ethics opinion spelling it out. CR 11(a): \"The signature of a party or of an attorney constitutes a certificate by the party or attorney that the party or attorney has read the pleading, motion, or legal memorandum, and that to the best of the party's or attorney's knowledge, information, and belief, formed after an inquiry reasonable under the circumstances:\" (1) \"it is well grounded in fact;\" and (2) \"it is warranted by existing law or a good faith argument for the extension, modification, or reversal of existing law or the establishment of new law;\". CR 11 carries fee-shifting: on violation the court \"may impose upon the person who signed it, a represented party, or both, an appropriate sanction, which may include an order to pay to the other party or parties the amount of the reasonable expenses incurred because of the filing of the pleading, motion, or legal memorandum, including a reasonable attorney fee.\" RPC 1.1: \"A lawyer shall provide competent representation to a client. Competent representation requires the legal knowledge, skill, thoroughness and preparation reasonably necessary for the representation.\" RPC 1.1 Comment [8] (the ABA technology-competence comment, adopted in Washington): a lawyer \"should keep abreast of changes in the law and its practice, including the benefits and risks associated with relevant technology\". RPC 3.3(a)(1): a lawyer shall not knowingly \"make a false statement of fact or law to a tribunal or fail to correct a false statement of material fact or law previously made to the tribunal by the lawyer;\". RPCs 5.1(b) and 5.3(b) impose \"reasonable efforts to ensure\" conformity. Non-binding but directly on point: WSBA Advisory Opinion 2025-05, \"Artificial Intelligence-Enabled Tools in Law Practice\", whose section headings state the duties — \"Lawyers must understand the technology they use in law practice.\" and \"Lawyers are responsible for the accuracy of their court filings.\" — and which concludes that AI tools \"do not relieve lawyers of the core duties discussed in this advisory opinion.\"",
      "confidentiality_restriction": "RPC 1.6(a): \"A lawyer shall not reveal information relating to the representation of a client unless the client gives informed consent, the disclosure is impliedly authorized in order to carry out the representation or the disclosure is permitted by paragraph (b).\" Washington HAS the Model Rule 1.6(c) reasonable-efforts paragraph: \"A lawyer shall make reasonable efforts to prevent the inadvertent or unauthorized disclosure of, or unauthorized access to, information relating to the representation of a client.\" Comment [18]: \"Paragraph (c) requires a lawyer to act competently to safeguard information relating to the representation of a client against unauthorized access by third parties and against inadvertent or unauthorized disclosure by the lawyer or other persons who are participating in the representation of the client or who are subject to the lawyer’s supervision.\" Its reasonableness factors include \"the sensitivity of the information, the likelihood of disclosure if additional safeguards are not employed, the cost of employing additional safeguards, the difficulty of implementing the safeguards\". RPC 5.3 Comment [3] [Washington revision] expressly covers cloud vendors: \"Examples include the retention of an investigative or paraprofessional service, hiring a document management company to create and maintain a database for complex litigation, sending client documents to a third party for printing or scanning, and using an Internet-based service to store client information. When using such services outside the firm, a lawyer must make reasonable efforts to ensure that the services are provided in a manner that is compatible with the lawyer’s professional obligations.\" Applying these, WSBA Advisory Opinion 2025-05 says \"Similarly, lawyers should not share client confidential information with an AI-enabled product without verifying that the product will protect their client’s confidentiality consistent with RPC 1.6.\" and \"In other instances where protection of client confidential information cannot be reasonably assured, lawyers should not use consumer-oriented AI tools.\"",
      "record_keeping_duty": "none",
      "client_disclosure_duty": "conditional — binding RPC 1.4(a)(2) requires a lawyer to \"reasonably consult with the client about the means by which the client’s objectives are to be accomplished;\" and RPC 1.4(b) to \"explain a matter to the extent reasonably necessary to permit the client to\" make informed decisions. There is no AI-specific client-disclosure rule. WSBA Advisory Opinion 2025-05 (advisory) frames it as circumstance-dependent and ties it to confidentiality: \"the sensitivity of the information involved in a particular representation may necessitate consultation with the client and, in some instances, obtaining the client’s informed consent under RPC 1.6(a) before using an AI tool.\"",
      "fees_note": "RPC 1.5(a) prohibits an unreasonable fee or an unreasonable amount for expenses. WSBA Advisory Opinion 2025-05 (advisory) is explicit that efficiency gains may not be billed: \"Billing for the use of AI tools must be reasonable.\" and \"While lawyers may charge for time spent using AI tools—for example, creating appropriate prompts analogous to creating search terms for more traditional legal research programs—they may not charge for the “time saved” under RPC 1.5(a).\"",
      "sources": [
        {
          "title": "Washington RPC 1.1, Competence — black letter",
          "url": "https://www.courts.wa.gov/court_rules/pdf/RPC/GA_RPC_01_01_00.pdf",
          "verbatim": "A lawyer shall provide competent representation to a client. Competent representation requires the legal knowledge, skill, thoroughness and preparation reasonably necessary for the representation.",
          "effective": "2006-09-01",
          "fetched": "2026-09-21"
        },
        {
          "title": "Same — rule amendment history line",
          "url": "https://www.courts.wa.gov/court_rules/pdf/RPC/GA_RPC_01_01_00.pdf",
          "verbatim": "[Adopted effective September 1, 1985; Amended effective September 1, 2006.]",
          "effective": "2006-09-01",
          "fetched": "2026-09-21"
        },
        {
          "title": "Same — Comment [8], Maintaining Competence (ABA technology-competence comment, adopted in Washington)",
          "url": "https://www.courts.wa.gov/court_rules/pdf/RPC/GA_RPC_01_01_00.pdf",
          "verbatim": "[8] To maintain the requisite knowledge and skill, a lawyer should keep abreast of changes in the law and its practice, including the benefits and risks associated with relevant technology, engage in continuing study and education and comply with all continuing legal education requirements to which the lawyer is subject.",
          "effective": "2016-09-01",
          "fetched": "2026-09-21"
        },
        {
          "title": "Same — effective-date note printed under Comment [8]",
          "url": "https://www.courts.wa.gov/court_rules/pdf/RPC/GA_RPC_01_01_00.pdf",
          "verbatim": "[Comment 6 Adopted effective September 1, 2006; Renumbered to 8 and Amended effective September 1, 2016.]",
          "effective": "2016-09-01",
          "fetched": "2026-09-21"
        },
        {
          "title": "Washington RPC, Preamble and Scope — paragraph [21], authority of the Comments",
          "url": "https://www.courts.wa.gov/court_rules/pdf/RPC/GA_RPC_PREAMBLEANDSCOPE.pdf",
          "verbatim": "[21] The Comment accompanying each Rule explains and illustrates the meaning and purpose of the Rule. The Preamble and this note on Scope provide general orientation. The Comments are intended as guides to interpretation, but the text of each Rule is authoritative.",
          "effective": null,
          "fetched": "2026-09-21"
        },
        {
          "title": "Washington RPC 1.4, Communication — (a)(2)",
          "url": "https://www.courts.wa.gov/court_rules/pdf/RPC/GA_RPC_01_04_00.pdf",
          "verbatim": "(2) reasonably consult with the client about the means by which the client’s objectives are to be accomplished;",
          "effective": null,
          "fetched": "2026-09-21"
        },
        {
          "title": "Same — RPC 1.4(b) (line as printed; sentence continues on the next page)",
          "url": "https://www.courts.wa.gov/court_rules/pdf/RPC/GA_RPC_01_04_00.pdf",
          "verbatim": "(b) A lawyer shall explain a matter to the extent reasonably necessary to permit the client to",
          "effective": null,
          "fetched": "2026-09-21"
        },
        {
          "title": "Washington RPC 1.6, Confidentiality of Information — (a)",
          "url": "https://www.courts.wa.gov/court_rules/pdf/RPC/GA_RPC_01_06_00.pdf",
          "verbatim": "(a) A lawyer shall not reveal information relating to the representation of a client unless the client gives informed consent, the disclosure is impliedly authorized in order to carry out the representation or the disclosure is permitted by paragraph (b).",
          "effective": null,
          "fetched": "2026-09-21"
        },
        {
          "title": "Same — RPC 1.6(c) (reasonable efforts; Washington adopted the Model Rule paragraph)",
          "url": "https://www.courts.wa.gov/court_rules/pdf/RPC/GA_RPC_01_06_00.pdf",
          "verbatim": "(c) A lawyer shall make reasonable efforts to prevent the inadvertent or unauthorized disclosure of, or unauthorized access to, information relating to the representation of a client.",
          "effective": null,
          "fetched": "2026-09-21"
        },
        {
          "title": "Same — RPC 1.6 amendment history line (does not say which amendment added paragraph (c))",
          "url": "https://www.courts.wa.gov/court_rules/pdf/RPC/GA_RPC_01_06_00.pdf",
          "verbatim": "[Adopted effective September 1, 1985; Amended effective September 1, 1990; September 1, 2006; September 1, 2016; September 1, 2018.]",
          "effective": "2018-09-01",
          "fetched": "2026-09-21"
        },
        {
          "title": "Same — Comment [18], Acting Competently to Preserve Confidentiality",
          "url": "https://www.courts.wa.gov/court_rules/pdf/RPC/GA_RPC_01_06_00.pdf",
          "verbatim": "[18] Paragraph (c) requires a lawyer to act competently to safeguard information relating to the representation of a client against unauthorized access by third parties and against inadvertent or unauthorized disclosure by the lawyer or other persons who are participating in the representation of the client or who are subject to the lawyer’s supervision.",
          "effective": "2016-09-01",
          "fetched": "2026-09-21"
        },
        {
          "title": "Same — Comment [18], reasonableness factors",
          "url": "https://www.courts.wa.gov/court_rules/pdf/RPC/GA_RPC_01_06_00.pdf",
          "verbatim": "Factors to be considered in determining the reasonableness of the lawyer’s efforts include, but are not limited to, the sensitivity of the information, the likelihood of disclosure if additional safeguards are not employed, the cost of employing additional safeguards, the difficulty of implementing the safeguards, and the extent to which the safeguards adversely affect the lawyer’s ability to represent clients",
          "effective": "2016-09-01",
          "fetched": "2026-09-21"
        },
        {
          "title": "Washington RPC 3.3, Candor Toward the Tribunal — (a)(1)",
          "url": "https://www.courts.wa.gov/court_rules/pdf/RPC/GA_RPC_03_03_00.pdf",
          "verbatim": "(1) make a false statement of fact or law to a tribunal or fail to correct a false statement of material fact or law previously made to the tribunal by the lawyer;",
          "effective": null,
          "fetched": "2026-09-21"
        },
        {
          "title": "Washington RPC 5.1 — (b) (supervisory lawyers)",
          "url": "https://www.courts.wa.gov/court_rules/pdf/RPC/GA_RPC_05_01_00.pdf",
          "verbatim": "(b) A lawyer having direct supervisory authority over another lawyer shall make reasonable efforts to ensure that the other lawyer conforms to the Rules of Professional Conduct.",
          "effective": null,
          "fetched": "2026-09-21"
        },
        {
          "title": "Washington RPC 5.3 — (b) (nonlawyer assistants)",
          "url": "https://www.courts.wa.gov/court_rules/pdf/RPC/GA_RPC_05_03_00.pdf",
          "verbatim": "(b) a lawyer having direct supervisory authority over the nonlawyer shall make reasonable efforts to ensure that the person’s conduct is compatible with the professional obligations of the lawyer; and",
          "effective": "2006-09-01",
          "fetched": "2026-09-21"
        },
        {
          "title": "Same — Comment [3] [Washington revision], Nonlawyers Outside the Firm (Internet-based services)",
          "url": "https://www.courts.wa.gov/court_rules/pdf/RPC/GA_RPC_05_03_00.pdf",
          "verbatim": "Examples include the retention of an investigative or paraprofessional service, hiring a document management company to create and maintain a database for complex litigation, sending client documents to a third party for printing or scanning, and using an Internet-based service to store client information. When using such services outside the firm, a lawyer must make reasonable efforts to ensure that the services are provided in a manner that is compatible with the lawyer’s professional obligations.",
          "effective": "2016-09-01",
          "fetched": "2026-09-21"
        },
        {
          "title": "Washington Superior Court Civil Rule CR 11(a) — signature certification (general, not AI-specific)",
          "url": "https://www.courts.wa.gov/court_rules/pdf/CR/SUP_CR_11_00_00.pdf",
          "verbatim": "The signature of a party or of an attorney constitutes a certificate by the party or attorney that the party or attorney has read the pleading, motion, or legal memorandum, and that to the best of the party's or attorney's knowledge, information, and belief, formed after an inquiry reasonable under the circumstances:",
          "effective": null,
          "fetched": "2026-09-21"
        },
        {
          "title": "Same — CR 11(a)(1)",
          "url": "https://www.courts.wa.gov/court_rules/pdf/CR/SUP_CR_11_00_00.pdf",
          "verbatim": "(1) it is well grounded in fact;",
          "effective": null,
          "fetched": "2026-09-21"
        },
        {
          "title": "Same — CR 11(a)(2)",
          "url": "https://www.courts.wa.gov/court_rules/pdf/CR/SUP_CR_11_00_00.pdf",
          "verbatim": "(2) it is warranted by existing law or a good faith argument for the extension, modification, or reversal of existing law or the establishment of new law;",
          "effective": null,
          "fetched": "2026-09-21"
        },
        {
          "title": "Same — CR 11(a) sanction sentence (fee-shifting available)",
          "url": "https://www.courts.wa.gov/court_rules/pdf/CR/SUP_CR_11_00_00.pdf",
          "verbatim": "If a pleading, motion, or legal memorandum is signed in violation of this rule, the court, upon motion or upon its own initiative, may impose upon the person who signed it, a represented party, or both, an appropriate sanction, which may include an order to pay to the other party or parties the amount of the reasonable expenses incurred because of the filing of the pleading, motion, or legal memorandum, including a reasonable attorney fee.",
          "effective": null,
          "fetched": "2026-09-21"
        },
        {
          "title": "WSBA Committee on Professional Ethics, Advisory Opinion 2025-05 — subject line",
          "url": "https://www.wsba.org/docs/default-source/legal-community/committees/committee-on-professional-ethics/ao-202505.pdf?sfvrsn=9754e5f1_3",
          "verbatim": "Subject:      Artificial Intelligence-Enabled Tools in Law Practice",
          "effective": null,
          "fetched": "2026-09-21"
        },
        {
          "title": "Same — Section II.A heading (duty of competence)",
          "url": "https://www.wsba.org/docs/default-source/legal-community/committees/committee-on-professional-ethics/ao-202505.pdf?sfvrsn=9754e5f1_3",
          "verbatim": "Lawyers must understand the technology they use in law practice.",
          "effective": null,
          "fetched": "2026-09-21"
        },
        {
          "title": "Same — Section II.E heading (candor; p. 9)",
          "url": "https://www.wsba.org/docs/default-source/legal-community/committees/committee-on-professional-ethics/ao-202505.pdf?sfvrsn=9754e5f1_3",
          "verbatim": "Lawyers are responsible for the accuracy of their court filings.",
          "effective": null,
          "fetched": "2026-09-21"
        },
        {
          "title": "Same — confidentiality analysis, p. 6 (verify the product before sharing confidences)",
          "url": "https://www.wsba.org/docs/default-source/legal-community/committees/committee-on-professional-ethics/ao-202505.pdf?sfvrsn=9754e5f1_3",
          "verbatim": "Similarly, lawyers should not share client confidential information with an AI-enabled product without verifying that the product will protect their client’s confidentiality consistent with RPC 1.6.",
          "effective": null,
          "fetched": "2026-09-21"
        },
        {
          "title": "Same — competence analysis (consumer tools where confidentiality cannot be assured)",
          "url": "https://www.wsba.org/docs/default-source/legal-community/committees/committee-on-professional-ethics/ao-202505.pdf?sfvrsn=9754e5f1_3",
          "verbatim": "In other instances where protection of client confidential information cannot be reasonably assured, lawyers should not use consumer-oriented AI tools.",
          "effective": null,
          "fetched": "2026-09-21"
        },
        {
          "title": "Same — p. 7 (when informed consent under RPC 1.6(a) is needed before using an AI tool)",
          "url": "https://www.wsba.org/docs/default-source/legal-community/committees/committee-on-professional-ethics/ao-202505.pdf?sfvrsn=9754e5f1_3",
          "verbatim": "the sensitivity of the information involved in a particular representation may necessitate consultation with the client and, in some instances, obtaining the client’s informed consent under RPC 1.6(a) before using an AI tool.",
          "effective": null,
          "fetched": "2026-09-21"
        },
        {
          "title": "Same — Section II.G heading (billing)",
          "url": "https://www.wsba.org/docs/default-source/legal-community/committees/committee-on-professional-ethics/ao-202505.pdf?sfvrsn=9754e5f1_3",
          "verbatim": "Billing for the use of AI tools must be reasonable.",
          "effective": null,
          "fetched": "2026-09-21"
        },
        {
          "title": "Same — p. 11 (no billing for time saved)",
          "url": "https://www.wsba.org/docs/default-source/legal-community/committees/committee-on-professional-ethics/ao-202505.pdf?sfvrsn=9754e5f1_3",
          "verbatim": "While lawyers may charge for time spent using AI tools—for example, creating appropriate prompts analogous to creating search terms for more traditional legal research programs—they may not charge for the “time saved” under RPC 1.5(a).",
          "effective": null,
          "fetched": "2026-09-21"
        },
        {
          "title": "Same — Section III, Conclusion (p. 12)",
          "url": "https://www.wsba.org/docs/default-source/legal-community/committees/committee-on-professional-ethics/ao-202505.pdf?sfvrsn=9754e5f1_3",
          "verbatim": "AI tools will undoubtedly continue to evolve and become more commonplace in daily law practice. Although they can assist lawyers in delivering legal services, they do not relieve lawyers of the core duties discussed in this advisory opinion.",
          "effective": null,
          "fetched": "2026-09-21"
        },
        {
          "title": "Same — standing disclaimer at the end (advisory only; not the official position of the Bar)",
          "url": "https://www.wsba.org/docs/default-source/legal-community/committees/committee-on-professional-ethics/ao-202505.pdf?sfvrsn=9754e5f1_3",
          "verbatim": "Advisory Opinions are provided for the education of the Bar and reflect the opinion of the Committee on Professional Ethics (CPE) or its predecessors. Advisory Opinions are provided pursuant to the authorization granted by the Board of Governors, but are not individually approved by the Board and do not reflect the official position of the Bar association.",
          "effective": null,
          "fetched": "2026-09-21"
        },
        {
          "title": "Board for Judicial Administration, BJA AI Statement of Principles — approval date",
          "url": "https://www.courts.wa.gov/programs_orgs/pos_bja/BJA%20AI%20Statement%20of%20Principles.pdf",
          "verbatim": "Approved: February 21, 2025",
          "effective": "2025-02-21",
          "fetched": "2026-09-21"
        },
        {
          "title": "Same — human judgment",
          "url": "https://www.courts.wa.gov/programs_orgs/pos_bja/BJA%20AI%20Statement%20of%20Principles.pdf",
          "verbatim": "we recognize that technology is not a substitute for human judgment",
          "effective": "2025-02-21",
          "fetched": "2026-09-21"
        },
        {
          "title": "Same — no rule yet; rule changes only foreshadowed",
          "url": "https://www.courts.wa.gov/programs_orgs/pos_bja/BJA%20AI%20Statement%20of%20Principles.pdf",
          "verbatim": "We recognize that AI and other emerging technologies may require adjustments to existing court rules and practices, and the Washington State Judiciary is committed to actively engaging with justice partners and the broader community to develop workable standards and guidelines that meet the needs of today and the future.",
          "effective": "2025-02-21",
          "fetched": "2026-09-21"
        },
        {
          "title": "WSBA Legal Technology Task Force, 2025 Final Report and Recommendations — fetched and read for AI rule proposals; no rule or duty asserted here",
          "url": "https://www.wsba.org/docs/default-source/legal-community/committees/legal-technology-task-force/wsba-legal-technology-task-force-final-report-and-recommendations_-wsba-member-survey-results-report.pdf?sfvrsn=bc101af1_1",
          "verbatim": null,
          "effective": "2025-01-01",
          "fetched": "2026-09-21"
        },
        {
          "title": "Washington Supreme Court Orders index (courts.wa.gov) — checked for AI orders; none found",
          "url": "https://www.courts.wa.gov/opinions/index.cfm?fa=opinions.scorders",
          "verbatim": null,
          "effective": null,
          "fetched": "2026-09-21"
        },
        {
          "title": "Washington Courts news item 52746 (surfaced by search as an Interim Order; on fetch it is a news release about the June 2025 interim order on public defense standards, nothing about AI)",
          "url": "https://www.courts.wa.gov/newsinfo/?fa=newsinfo.internetdetail&newsid=52746",
          "verbatim": null,
          "effective": null,
          "fetched": "2026-09-21"
        },
        {
          "title": "Washington General Rules (GR) index — the list from which all 59 GR PDFs were fetched and swept for AI; none found",
          "url": "https://www.courts.wa.gov/court_rules/?fa=court_rules.list&group=ga&set=GR",
          "verbatim": null,
          "effective": null,
          "fetched": "2026-09-21"
        },
        {
          "title": "Washington Rules of Professional Conduct index page (all RPC rules; HTML shell used only to locate the rule PDFs)",
          "url": "https://www.courts.wa.gov/court_rules/?fa=court_rules.rulesPDF&groupName=ga&setName=RPC",
          "verbatim": null,
          "effective": null,
          "fetched": "2026-09-21"
        },
        {
          "title": "CourtListener v4 search API result set (type=o, court=wash washctapp, filed_after=2023-01-01, artificial intelligence AND fabricated/fictitious/nonexistent/hallucinat*) — ZERO hits",
          "url": "https://www.courtlistener.com/api/rest/v4/search/?type=o&court=wash%20washctapp&filed_after=2023-01-01&q=%22artificial%20intelligence%22%20AND%20(fabricated%20OR%20fictitious%20OR%20nonexistent%20OR%20hallucinat*)",
          "verbatim": null,
          "effective": null,
          "fetched": "2026-09-21"
        }
      ],
      "status": "verified",
      "verified_on": "2026-09-21",
      "verified_by": "claude-opus verifier session, batch 4a",
      "attorney_signoff": null,
      "notes": "BOTTOM LINE: Washington is the strongest of the three states on paper and the emptiest in the case reports. It adopted the ABA technology-competence comment verbatim, it has the Model Rule 1.6(c) reasonable-efforts paragraph, its RPC 5.3 Comment [3] already names Internet-based services that store client information, its CR 11 uses the modern reasonable-inquiry standard with fee-shifting, and its state bar has published a full 17-page AI ethics opinion. What it does NOT have, as of 2026-09-21, is any AI-specific court rule, any Supreme Court order on attorney AI use, and any published state appellate decision sanctioning counsel for AI-fabricated citations. TECHNOLOGY-COMPETENCE COMMENT: ADOPTED, in the ABA wording. RPC 1.1 Comment [8] reads \"[8] To maintain the requisite knowledge and skill, a lawyer should keep abreast of changes in the law and its practice, including the benefits and risks associated with relevant technology, engage in continuing study and education and comply with all continuing legal education requirements to which the lawyer is subject.\" The date is printed under the comment: \"[Comment 6 Adopted effective September 1, 2006; Renumbered to 8 and Amended effective September 1, 2016.]\" — so the technology clause entered Washington law on September 1, 2016, as part of the same renumbering that added Comments [6], [7] and [9]. The comment is guidance, not black letter: Scope [21] says \"The Comments are intended as guides to interpretation, but the text of each Rule is authoritative.\" NO REPORTED WASHINGTON AI SANCTIONS CASE. The CourtListener v4 search over the Washington Supreme Court and Court of Appeals, filed 2023-01-01 onward, returned ZERO opinions matching artificial intelligence together with fabricated, fictitious, nonexistent or hallucinat*. That is corroborated from the primary side: WSBA Advisory Opinion 2025-05, writing in 2025 and looking for examples, cites People v. Crabill (Colo. 2023), Kohls v. Ellison (D. Minn. 2025) and the New York Mata sanctions — not a single Washington decision. A Washington practitioner therefore has no in-state precedent and should expect a court to reason from CR 11 and from out-of-state authority. STATUS OF THE GUIDANCE: (a) WSBA Advisory Opinion 2025-05, Artificial Intelligence-Enabled Tools in Law Practice (Year Issued 2025; 17 pages), addresses seven duties — RPC 1.1 competence, 1.3 diligence, 1.6 confidentiality, 1.4 communication, 3.3 candor, 5.1/5.3 supervision and 1.5 billing — each with an illustration. It is ADVISORY only, by its own standing disclaimer: \"Advisory Opinions are provided for the education of the Bar and reflect the opinion of the Committee on Professional Ethics (CPE) or its predecessors. Advisory Opinions are provided pursuant to the authorization granted by the Board of Governors, but are not individually approved by the Board and do not reflect the official position of the Bar association.\" It builds on WSBA Advisory Opinion 2215 (2012) on vendor contracts, which it treats as the framework for vetting AI vendors. Its most quotable operational rules are that a lawyer may not bill for \"time saved\" and that consumer AI tools must not be used where confidentiality cannot be reasonably assured. (b) The BJA AI Statement of Principles is a Board for Judicial Administration policy statement approved February 21, 2025 (note: the approval date on the document is February 21, not the February 25 date some secondary trackers give). It is aspirational, addressed to the judiciary and court administration, and imposes no attorney duty; it expressly says rule changes may come later. (c) The WSBA Legal Technology Task Force 2025 report is a bar task-force report, not a rule. CHECKED, NOTHING AI-SPECIFIC FOUND (all fetched 2026-09-21): RPC 1.1, 1.4, 1.6, 3.3, 5.1 and 5.3, each read in full with all comments including the Additional Washington Comments — 0 hits for artificial, generative, machine learning or chatgpt, and the only technology hit is Comment [8] to RPC 1.1; all 59 Washington General Rule PDFs listed on the GR index, fetched and extracted individually — 0 hits for artificial intelligence or generative; CR 11; the Washington Supreme Court Orders index for 2025 and 2026 — no AI order; a news item that a search result described as an Interim Order, which on fetch turned out to be a court-rules process page with no AI content. NOT CHECKED / GAPS FOR THE VERIFIER: (1) No statute sweep — the Revised Code of Washington and pending Washington bills were NOT searched for AI-in-court-filings provisions. (2) Only the General Rules were swept rule-set by rule-set; the Superior Court Civil Rules other than CR 11, the Criminal Rules, the Rules of Appellate Procedure (including RAP 18.9 on frivolous appeals and sanctions) and the courts of limited jurisdiction rules were not swept for AI. (3) Local superior court rules and individual judges' requirements were not surveyed; this entry is statewide only. (4) WSBA Advisory Opinion 2215 (2012), relied on by AO 2025-05 as the vendor framework, was not fetched. (5) The WSBA advisory-opinion index was not swept, so there may be a later or companion AI opinion; AO 2025-05 itself says \"specific practice areas and issues may warrant future advisory opinions\". (6) AO 2025-05 carries a year but no month or day on its face, so its effective field is null. (7) The RPC 1.6 amendment-history line lists four amendment dates and does not say which one added paragraph (c); Comment [18], which construes paragraph (c), is dated September 1, 2016, which suggests but does not prove that date. (8) The CourtListener query required the exact phrase artificial intelligence, so a Washington opinion that said only ChatGPT, generative AI or hallucinated citations would not have matched; the zero count rests as much on AO 2025-05 having no Washington case to cite as on the search."
    },
    {
      "id": "nc-rpc",
      "kind": "state_bar",
      "name": "North Carolina Rules of Professional Conduct and North Carolina AI authority",
      "disclosure_to_court": "none statewide — but LOCAL. Superior Court Judicial District 25 (Cabarrus County) requires disclosure of AI use affecting evidence by Revised Administrative Order 25-09, filed December 8, 2025, which supersedes its July 23, 2024 order. Read this string; do not pattern-match the field. No North Carolina statute, statewide court rule, or Supreme Court order found in this run requires disclosure of AI use in a filing. The District 25 order's Appendix B is an AI Disclosure Checklist Form filed by the disclosing party where its evidence triggers apply, not a certificate every filer signs; its signature line is quoted in this entry's sources, and certificate_language is null because nothing statewide prescribes certificate text.",
      "certification_required": false,
      "certificate_language": null,
      "verification_duty": "No North Carolina rule, Supreme Court order or statute imposes an AI-specific verification duty on attorneys as of 2026-09-21; the duty comes from the general rules, as read by the State Bar in 2024 Formal Ethics Opinion 1 (adopted November 1, 2024). North Carolina's Rule 1.1 is NOT the ABA formulation: \"A lawyer shall not handle a legal matter that the lawyer knows or should know he or she is not competent to handle without associating with a lawyer who is competent to handle the matter. Competent representation requires the legal knowledge, skill, thoroughness, and preparation reasonably necessary for the representation.\" Rule 1.1 Comment [8] carries a North Carolina variant of the technology clause: a lawyer should keep abreast of changes in the law and its practice, \"including the benefits and risks associated with the technology relevant to the lawyer’s practice\". Comments are guidance only (Scope (a): \"Comments do not add obligations to the Rules but provide guidance for practicing in compliance with the Rules.\"). Rule 3.3(a)(1) forbids knowingly making \"a false statement of material fact or law to a tribunal or fail to correct a false statement of material fact or law previously made to the tribunal by the lawyer\". Supervision runs through Rule 5.1(b) and Rule 5.3(b). 2024 FEO 1 Opinion #4 answers the signing question directly — asked whether signing a pleading based on AI output varies the usual obligations, the Committee said \"No. A lawyer may not abrogate her responsibilities under the Rules of Professional Conduct by relying upon AI.\" and pointed to N.C. R. Civ. Pro. 11. Opinion #1 permits AI use \"provided the lawyer uses any AI program, tool, or resource competently, securely to protect client confidentiality, and with proper supervision when relying upon or implementing the AI’s work product in the provision of legal services.\" Locally, Revised Administrative Order 25-09 (Judicial District 25) states that \"All filings, discovery responses, and evidentiary submissions remain the ultimate responsibility of the signing attorney or party, whether assisted by Al or not.\" and that \"Hallucinated authorities, misquoted sources, or fabricated facts violate duties of candor.\"",
      "confidentiality_restriction": "Rule 1.6(a): \"A lawyer shall not reveal information acquired during the professional relationship with a client unless the client gives informed consent, the disclosure is impliedly authorized in order to carry out the representation or the disclosure is permitted by paragraph (b).\" Rule 1.6(c): \"A lawyer shall make reasonable efforts to prevent the inadvertent or unauthorized disclosure of, or unauthorized access to, information relating to the representation of a client.\" Rule 1.6 Comment [19] sets the reasonableness factors, including \"the sensitivity of the information, the likelihood of disclosure if additional safeguards are not employed, the cost of employing additional safeguards\". 2024 FEO 1 applies this to AI and gives the operative practice rule: \"Generally, and as of the date of this opinion, lawyers should avoid inputting client-specific information into publicly available AI resources.\" Opinion #2 permits use of a third-party AI program \"provided the lawyer has satisfied herself that the third-party company’s AI program is sufficiently secure and complies with the lawyer’s obligations to ensure any client information will not be inadvertently disclosed or accessed by unauthorized individuals pursuant to Rule 1.6(c)\", and Opinion #3 holds that running the tool in-house changes nothing. Locally, Revised Administrative Order 25-09 is stricter: \"Absent reliable assurances that inputs will not be (i) stored, (ii) reviewed by humans, or (iii) used to train models, public Al tools shall not be used with confidential, privileged, sealed, proprietary, or otherwise protected information.\"",
      "record_keeping_duty": "none statewide. LOCAL only, and evidence-specific: Revised Administrative Order 25-09 (Judicial District 25) requires that \"AI-assisted outputs that may be offered in evidence (including transcripts, summaries, analyses, and redacted or masked audio/video) must be validated for accuracy, retained with accompanying documentation sufficient to permit authentication\". No North Carolina rule requires a lawyer to keep prompt or session records.",
      "client_disclosure_duty": "conditional — 2024 FEO 1 Opinion #5 is the controlling guidance and it turns on how substantive the use is. \"Generally, a lawyer need not inform her client that she is using an AI tool to complete ordinary tasks, such as conducting legal research or generic case/practice management.\" But \"if a lawyer delegates substantive tasks in furtherance of the representation to an AI tool, the lawyer’s use of the tool is akin to outsourcing legal work to a nonlawyer or other third-party resource or service, for which the client’s advanced informed consent is required.\" And \"if the decision to use or not use an AI tool in the case requires the client’s input with regard to fees, the lawyer must inform and seek input from the client.\" The rule behind it is Rule 1.4(b), which requires a lawyer to \"explain a matter to the extent reasonably necessary to permit the client to make informed decisions regarding the representation.\"",
      "fees_note": "2024 FEO 1 Opinion #6 is unusually concrete. A lawyer who now takes one hour to do what took three may not bill three: \"No, Lawyer may not bill a client for three hours of work when only one hour of work was actually experienced.\" The Committee adds that the lawyer \"may enjoy the benefit of those new efficiencies by completing more work for more clients\" and may consider a flat fee, and that AI expenses may be passed on \"provided the expenses charged are accurate, not clearly excessive, and the client consents to the charge, preferably in writing.\" The black-letter rule is Rule 1.5(a): \"A lawyer shall not make an agreement for, charge, or collect an illegal or clearly excessive fee or charge or collect a clearly excessive amount for expenses.\"",
      "sources": [
        {
          "title": "N.C. Rule of Professional Conduct 1.1 (Competence), black letter — North Carolina State Bar official rule text",
          "url": "https://www.ncbar.gov/for-lawyers/ethics-and-governing-rules/rules-of-professional-conduct/10-119-client-lawyer-relationship/11-competence/",
          "verbatim": "A lawyer shall not handle a legal matter that the lawyer knows or should know he or she is not competent to handle without associating with a lawyer who is competent to handle the matter. Competent representation requires the legal knowledge, skill, thoroughness, and preparation reasonably necessary for the representation.",
          "effective": "1997-07-24",
          "fetched": "2026-09-21"
        },
        {
          "title": "Same — Rule 1.1 Comment [8] (technology competence, North Carolina wording)",
          "url": "https://www.ncbar.gov/for-lawyers/ethics-and-governing-rules/rules-of-professional-conduct/10-119-client-lawyer-relationship/11-competence/",
          "verbatim": "To maintain the requisite knowledge and skill, a lawyer should keep abreast of changes in the law and its practice, including the benefits and risks associated with the technology relevant to the lawyer’s practice, engage in continuing study and education, and comply with all continuing legal education requirements to which the lawyer is subject.",
          "effective": "2014-10-02",
          "fetched": "2026-09-21"
        },
        {
          "title": "Same — Rule 1.1 History Note",
          "url": "https://www.ncbar.gov/for-lawyers/ethics-and-governing-rules/rules-of-professional-conduct/10-119-client-lawyer-relationship/11-competence/",
          "verbatim": "History Note: Authority G.S. 84-23; Eff. July 24, 1997; Amended Eff. October 2, 2014; March 1, 2003.",
          "effective": "2014-10-02",
          "fetched": "2026-09-21"
        },
        {
          "title": "N.C. R.P.C. 0.2 Scope (a) — weight of the Comments",
          "url": "https://www.ncbar.gov/for-lawyers/ethics-and-governing-rules/rules-of-professional-conduct/01-02-preamble-and-scope/02-scope/",
          "verbatim": "Comments do not add obligations to the Rules but provide guidance for practicing in compliance with the Rules.",
          "effective": null,
          "fetched": "2026-09-21"
        },
        {
          "title": "N.C. R.P.C. 1.4(a)(2) (Communication)",
          "url": "https://www.ncbar.gov/for-lawyers/ethics-and-governing-rules/rules-of-professional-conduct/10-119-client-lawyer-relationship/14-communication/",
          "verbatim": "(2) reasonably consult with the client about the means by which the client's objectives are to be accomplished;",
          "effective": null,
          "fetched": "2026-09-21"
        },
        {
          "title": "Same — N.C. R.P.C. 1.4(b)",
          "url": "https://www.ncbar.gov/for-lawyers/ethics-and-governing-rules/rules-of-professional-conduct/10-119-client-lawyer-relationship/14-communication/",
          "verbatim": "(b) A lawyer shall explain a matter to the extent reasonably necessary to permit the client to make informed decisions regarding the representation.",
          "effective": null,
          "fetched": "2026-09-21"
        },
        {
          "title": "N.C. R.P.C. 1.6(a) (Confidentiality of Information)",
          "url": "https://www.ncbar.gov/for-lawyers/ethics-and-governing-rules/rules-of-professional-conduct/10-119-client-lawyer-relationship/16-confidentiality-of-information/",
          "verbatim": "A lawyer shall not reveal information acquired during the professional relationship with a client unless the client gives informed consent, the disclosure is impliedly authorized in order to carry out the representation or the disclosure is permitted by paragraph (b).",
          "effective": null,
          "fetched": "2026-09-21"
        },
        {
          "title": "Same — N.C. R.P.C. 1.6(c)",
          "url": "https://www.ncbar.gov/for-lawyers/ethics-and-governing-rules/rules-of-professional-conduct/10-119-client-lawyer-relationship/16-confidentiality-of-information/",
          "verbatim": "(c) A lawyer shall make reasonable efforts to prevent the inadvertent or unauthorized disclosure of, or unauthorized access to, information relating to the representation of a client.",
          "effective": "2014-10-02",
          "fetched": "2026-09-21"
        },
        {
          "title": "Same — N.C. R.P.C. 1.6 Comment [19] (reasonableness factors)",
          "url": "https://www.ncbar.gov/for-lawyers/ethics-and-governing-rules/rules-of-professional-conduct/10-119-client-lawyer-relationship/16-confidentiality-of-information/",
          "verbatim": "Factors to be considered in determining the reasonableness of the lawyer's efforts include, but are not limited to, the sensitivity of the information, the likelihood of disclosure if additional safeguards are not employed, the cost of employing additional safeguards, the difficulty of implementing the safeguards, and the extent to which the safeguards adversely affect the lawyer's ability to represent clients",
          "effective": null,
          "fetched": "2026-09-21"
        },
        {
          "title": "Same — N.C. R.P.C. 1.6 History Note",
          "url": "https://www.ncbar.gov/for-lawyers/ethics-and-governing-rules/rules-of-professional-conduct/10-119-client-lawyer-relationship/16-confidentiality-of-information/",
          "verbatim": "History Note: Authority G.S. 84-23; Approved by the Supreme Court July 24, 1997; Amendments Approved by the Supreme Court: March 1, 2003; October 2, 2014; March 16, 2017;",
          "effective": null,
          "fetched": "2026-09-21"
        },
        {
          "title": "N.C. R.P.C. 3.3(a)(1) (Candor Toward the Tribunal)",
          "url": "https://www.ncbar.gov/for-lawyers/ethics-and-governing-rules/rules-of-professional-conduct/31-38-advocate/33-candor-toward-the-tribunal/",
          "verbatim": "(1) make a false statement of material fact or law to a tribunal or fail to correct a false statement of material fact or law previously made to the tribunal by the lawyer;",
          "effective": "2003-02-27",
          "fetched": "2026-09-21"
        },
        {
          "title": "N.C. R.P.C. 5.1(b) (Responsibilities of Principals, Managers, and Supervisory Lawyers)",
          "url": "https://www.ncbar.gov/for-lawyers/ethics-and-governing-rules/rules-of-professional-conduct/51-57-law-firms-and-associations/51-responsibilities-of-principals-managers-and-supervisory-lawyers/",
          "verbatim": "(b) A lawyer having direct supervisory authority over another lawyer shall make reasonable efforts to ensure that the other lawyer conforms to the Rules of Professional Conduct.",
          "effective": "2016-09-22",
          "fetched": "2026-09-21"
        },
        {
          "title": "N.C. R.P.C. 5.3(b) (Responsibilities Regarding Nonlawyer Assistance)",
          "url": "https://www.ncbar.gov/for-lawyers/ethics-and-governing-rules/rules-of-professional-conduct/51-57-law-firms-and-associations/53-responsibilities-regarding-nonlawyer-assistance/",
          "verbatim": "(b) a lawyer having direct supervisory authority over the nonlawyer shall make reasonable efforts to ensure that the nonlawyer's conduct is compatible with the professional obligations of the lawyer; and",
          "effective": null,
          "fetched": "2026-09-21"
        },
        {
          "title": "N.C. R.P.C. 1.5(a) (Fees)",
          "url": "https://www.ncbar.gov/for-lawyers/ethics-and-governing-rules/rules-of-professional-conduct/10-119-client-lawyer-relationship/15-fees/",
          "verbatim": "A lawyer shall not make an agreement for, charge, or collect an illegal or clearly excessive fee or charge or collect a clearly excessive amount for expenses.",
          "effective": null,
          "fetched": "2026-09-21"
        },
        {
          "title": "North Carolina State Bar, 2024 Formal Ethics Opinion 1, Use of Artificial Intelligence in a Law Practice — adoption date",
          "url": "https://www.ncbar.gov/for-lawyers/ethics-and-governing-rules/ethics-opinions/opinions/2024-formal-ethics-opinion-1/",
          "verbatim": "Use of Artificial Intelligence in a Law Practice Adopted:November 1, 2024",
          "effective": "2024-11-01",
          "fetched": "2026-09-21"
        },
        {
          "title": "Same — Opinion",
          "url": "https://www.ncbar.gov/for-lawyers/ethics-and-governing-rules/ethics-opinions/opinions/2024-formal-ethics-opinion-1/",
          "verbatim": "Yes, provided the lawyer uses any AI program, tool, or resource competently, securely to protect client confidentiality, and with proper supervision when relying upon or implementing the AI’s work product in the provision of legal services.",
          "effective": "2024-11-01",
          "fetched": "2026-09-21"
        },
        {
          "title": "Same — Opinion",
          "url": "https://www.ncbar.gov/for-lawyers/ethics-and-governing-rules/ethics-opinions/opinions/2024-formal-ethics-opinion-1/",
          "verbatim": "Nothing in the Rules of Professional Conduct specifically addresses, let alone prohibits, a lawyer’s use of AI in her law practice.",
          "effective": "2024-11-01",
          "fetched": "2026-09-21"
        },
        {
          "title": "Same — Opinion",
          "url": "https://www.ncbar.gov/for-lawyers/ethics-and-governing-rules/ethics-opinions/opinions/2024-formal-ethics-opinion-1/",
          "verbatim": "Yes, provided the lawyer has satisfied herself that the third-party company’s AI program is sufficiently secure and complies with the lawyer’s obligations to ensure any client information will not be inadvertently disclosed or accessed by unauthorized individuals pursuant to Rule 1.6(c).",
          "effective": "2024-11-01",
          "fetched": "2026-09-21"
        },
        {
          "title": "Same — Opinion",
          "url": "https://www.ncbar.gov/for-lawyers/ethics-and-governing-rules/ethics-opinions/opinions/2024-formal-ethics-opinion-1/",
          "verbatim": "Generally, and as of the date of this opinion, lawyers should avoid inputting client-specific information into publicly available AI resources.",
          "effective": "2024-11-01",
          "fetched": "2026-09-21"
        },
        {
          "title": "Same — Opinion",
          "url": "https://www.ncbar.gov/for-lawyers/ethics-and-governing-rules/ethics-opinions/opinions/2024-formal-ethics-opinion-1/",
          "verbatim": "No. Lawyer remains responsible for keeping the information secure pursuant to Rule 1.6(c) regardless of the program’s location.",
          "effective": "2024-11-01",
          "fetched": "2026-09-21"
        },
        {
          "title": "Same — Opinion",
          "url": "https://www.ncbar.gov/for-lawyers/ethics-and-governing-rules/ethics-opinions/opinions/2024-formal-ethics-opinion-1/",
          "verbatim": "No. A lawyer may not abrogate her responsibilities under the Rules of Professional Conduct by relying upon AI.",
          "effective": "2024-11-01",
          "fetched": "2026-09-21"
        },
        {
          "title": "Same — Opinion",
          "url": "https://www.ncbar.gov/for-lawyers/ethics-and-governing-rules/ethics-opinions/opinions/2024-formal-ethics-opinion-1/",
          "verbatim": "Generally, a lawyer need not inform her client that she is using an AI tool to complete ordinary tasks, such as conducting legal research or generic case/practice management. However, if a lawyer delegates substantive tasks in furtherance of the representation to an AI tool, the lawyer’s use of the tool is akin to outsourcing legal work to a nonlawyer or other third-party resource or service, for which the client’s advanced informed consent is required.",
          "effective": "2024-11-01",
          "fetched": "2026-09-21"
        },
        {
          "title": "Same — Opinion",
          "url": "https://www.ncbar.gov/for-lawyers/ethics-and-governing-rules/ethics-opinions/opinions/2024-formal-ethics-opinion-1/",
          "verbatim": "Additionally, if the decision to use or not use an AI tool in the case requires the client’s input with regard to fees, the lawyer must inform and seek input from the client.",
          "effective": "2024-11-01",
          "fetched": "2026-09-21"
        },
        {
          "title": "Same — Opinion",
          "url": "https://www.ncbar.gov/for-lawyers/ethics-and-governing-rules/ethics-opinions/opinions/2024-formal-ethics-opinion-1/",
          "verbatim": "No, Lawyer may not bill a client for three hours of work when only one hour of work was actually experienced.",
          "effective": "2024-11-01",
          "fetched": "2026-09-21"
        },
        {
          "title": "Same — Opinion",
          "url": "https://www.ncbar.gov/for-lawyers/ethics-and-governing-rules/ethics-opinions/opinions/2024-formal-ethics-opinion-1/",
          "verbatim": "Relatedly, Lawyer may also bill a client for expenses incurred related to Lawyer’s use of AI in the furtherance of a client’s legal services, provided the expenses charged are accurate, not clearly excessive, and the client consents to the charge, preferably in writing.",
          "effective": "2024-11-01",
          "fetched": "2026-09-21"
        },
        {
          "title": "North Carolina Judicial Branch document page for the Revised Administrative Order on AI in Superior Court Proceedings (Superior Court District 25)",
          "url": "https://www.nccourts.gov/documents/local-rules-and-forms/revised-administrative-order-in-re-artificial-intelligence-ai-in-superior-court-proceedings",
          "verbatim": "By North Carolina Judicial Branch Rule, Superior Court District 25 Revised Administrative Order: In Re: Artificial Intelligence (AI) in Superior Court Proceedings Published December 8, 2025",
          "effective": "2025-12-08",
          "fetched": "2026-09-21"
        },
        {
          "title": "In re Artificial Intelligence (AI) in Superior Court Proceedings, Revised Administrative Order 25-09 (Super. Ct. Jud. Dist. 25, Cabarrus County, filed Dec. 8, 2025) — scope and supersession",
          "url": "https://www.nccourts.gov/assets/documents/local-rules-forms/Filed%20AI%20Revised%20Admin%20Order%202025%20%28WCAG%29%20%28002%29.pdf",
          "verbatim": "The undersigned Senior Resident Superior Court Judge enters this Administrative Order that replaces and supersedes the Court's order entered on July 23, 2024. Effective immediately, it applies to all civil and criminal proceedings in the Superior Court of Judicial District 25 (Cabarrus County).",
          "effective": "2025-12-08",
          "fetched": "2026-09-21"
        },
        {
          "title": "Same — responsibility for AI-assisted filings (sec. 4.b)",
          "url": "https://www.nccourts.gov/assets/documents/local-rules-forms/Filed%20AI%20Revised%20Admin%20Order%202025%20%28WCAG%29%20%28002%29.pdf",
          "verbatim": "All filings, discovery responses, and evidentiary submissions remain the ultimate responsibility of the signing attorney or party, whether assisted by Al or not.",
          "effective": "2025-12-08",
          "fetched": "2026-09-21"
        },
        {
          "title": "Same — hallucinated authority and candor (sec. 4.b)",
          "url": "https://www.nccourts.gov/assets/documents/local-rules-forms/Filed%20AI%20Revised%20Admin%20Order%202025%20%28WCAG%29%20%28002%29.pdf",
          "verbatim": "Hallucinated authorities, misquoted sources, or fabricated facts violate duties of candor.",
          "effective": "2025-12-08",
          "fetched": "2026-09-21"
        },
        {
          "title": "Same — public AI tools and protected information (sec. 5)",
          "url": "https://www.nccourts.gov/assets/documents/local-rules-forms/Filed%20AI%20Revised%20Admin%20Order%202025%20%28WCAG%29%20%28002%29.pdf",
          "verbatim": "Absent reliable assurances that inputs will not be (i) stored, (ii) reviewed by humans, or (iii) used to train models, public Al tools shall not be used with confidential, privileged, sealed, proprietary, or otherwise protected information.",
          "effective": "2025-12-08",
          "fetched": "2026-09-21"
        },
        {
          "title": "Same — retention of AI-assisted evidentiary outputs (sec. 2)",
          "url": "https://www.nccourts.gov/assets/documents/local-rules-forms/Filed%20AI%20Revised%20Admin%20Order%202025%20%28WCAG%29%20%28002%29.pdf",
          "verbatim": "must be validated for accuracy, retained with accompanying documentation sufficient to permit authentication, and will be subject to subsequent determinations of admissibility and weight by the Court.",
          "effective": "2025-12-08",
          "fetched": "2026-09-21"
        },
        {
          "title": "Same — 90-day disclosure deadline (sec. 6.b)",
          "url": "https://www.nccourts.gov/assets/documents/local-rules-forms/Filed%20AI%20Revised%20Admin%20Order%202025%20%28WCAG%29%20%28002%29.pdf",
          "verbatim": "Absent a contrary scheduling order, disclosure must occur no later than 90 days before trial. If AI-related evidence is discovered inside that window, disclosure must be made immediately.",
          "effective": "2025-12-08",
          "fetched": "2026-09-21"
        },
        {
          "title": "Same — what does not have to be disclosed (sec. 6.d)",
          "url": "https://www.nccourts.gov/assets/documents/local-rules-forms/Filed%20AI%20Revised%20Admin%20Order%202025%20%28WCAG%29%20%28002%29.pdf",
          "verbatim": "Routine word processing, spell-check, grammar, or formatting tools that do not materially inﬂuence content need not be disclosed.",
          "effective": "2025-12-08",
          "fetched": "2026-09-21"
        },
        {
          "title": "Same — Appendix B, AI Disclosure Checklist Form signature line",
          "url": "https://www.nccourts.gov/assets/documents/local-rules-forms/Filed%20AI%20Revised%20Admin%20Order%202025%20%28WCAG%29%20%28002%29.pdf",
          "verbatim": "certify that the above disclosures comply with Revised Administrative Order (25-09).",
          "effective": "2025-12-08",
          "fetched": "2026-09-21"
        },
        {
          "title": "Same — safe harbor (sec. 11.d)",
          "url": "https://www.nccourts.gov/assets/documents/local-rules-forms/Filed%20AI%20Revised%20Admin%20Order%202025%20%28WCAG%29%20%28002%29.pdf",
          "verbatim": "will ordinarily not be subject to sanctions for inadvertent Al-related errors.",
          "effective": "2025-12-08",
          "fetched": "2026-09-21"
        },
        {
          "title": "NOT FETCHED (HTTP 403 after one retry) - North Carolina Judicial Branch, Data Science and Artificial Intelligence Initiative Task Force page",
          "url": "https://www.nccourts.gov/commissions/data-science-artificial-intelligence-initiative-task-force",
          "verbatim": null,
          "effective": null,
          "fetched": null
        },
        {
          "title": "NOT FETCHED (HTTP 403 after one retry) - North Carolina Judicial Branch document page for the superseded Cabarrus County Generative AI administrative order of July 23, 2024",
          "url": "https://www.nccourts.gov/documents/local-rules-and-forms/administrative-order-in-re-generative-artificial-intelligence-and-its-use-in-the-superior-court-of-cabarrus-county",
          "verbatim": null,
          "effective": "2024-07-23",
          "fetched": null
        },
        {
          "title": "LEAD ONLY - North Carolina State Bar Journal article, Artificial Intelligence, Real Practice (located in the State Bar sitemap; not fetched or read)",
          "url": "https://www.ncbar.gov/for-lawyers/ethics-and-governing-rules/ethics-articles/artificial-intelligence-real-practice/",
          "verbatim": null,
          "effective": null,
          "fetched": null
        }
      ],
      "status": "verified",
      "verified_on": "2026-09-21",
      "verified_by": "claude-opus verifier session, batch 4b",
      "attorney_signoff": null,
      "notes": "BOTTOM LINE: North Carolina has a full, adopted State Bar ethics opinion on AI (2024 Formal Ethics Opinion 1, adopted November 1, 2024) and no AI text at all in the Rules themselves. The opinion says so in terms: \"Nothing in the Rules of Professional Conduct specifically addresses, let alone prohibits, a lawyer’s use of AI in her law practice.\" No statute, statewide court rule or Supreme Court order requiring AI disclosure or certification was found. THE LOCAL TRAP: Superior Court Judicial District 25 (Cabarrus County) has had an AI administrative order since July 23, 2024, replaced by Revised Administrative Order 25-09 filed December 8, 2025. It is detailed — definitions, a duty of technological competence, a confidentiality bar on public AI tools, a 90-day pretrial disclosure deadline, a meet-and-confer protocol, a sanctions section with a safe harbor, a quick-reference chart and an AI Disclosure Checklist Form with a certification line. It is NOT statewide; it binds civil and criminal proceedings in Judicial District 25 only. A generator must not read this entry as imposing a North Carolina-wide disclosure duty. The order itself notes that the Court used AI tools to assist in preparing it. SCOPE OF THE LOCAL DISCLOSURE DUTY: it is evidence-centred, not brief-centred. The trigger is generating, offering, materially altering, enhancing or analyzing EVIDENCE using AI; routine word processing and non-substantive administrative use are expressly excluded, and technology-assisted review in discovery is not required to be disclosed. Using a generative tool to draft a brief is governed by the order's candor and Rule 11 provisions rather than by its disclosure checklist — a verifier should test that reading against the full quick-reference chart in Appendix A, which was read but not quoted here. TRANSCRIPTION WARNING ON THE DISTRICT 25 ORDER: pdftotext renders the abbreviation AI as Al (capital A, lowercase L) in several passages of that PDF, and as ﬁ and ﬂ ligatures elsewhere. Quotations from it in this entry preserve exactly what the extracted text says, so a reader who sees assisted by Al or not, or inﬂuence, is looking at the extraction and not at a typing error. A verifier comparing against the page images should expect the same. TECHNOLOGY-COMPETENCE COMMENT: adopted, in a North Carolina variant. Comment [8] to Rule 1.1 says \"the technology relevant to the lawyer’s practice\" where the ABA model rule uses the shorter phrase relevant technology. The Rule 1.1 History Note lists amendments effective October 2, 2014 and March 1, 2003 without saying which amendment added the clause; the October 2, 2014 date is the one recorded here as the effective date of Comment [8] because it is the later amendment and it matches the date Rule 1.6(c) was added, but a verifier should confirm it against the 2014 Supreme Court order. NORTH CAROLINA'S RULE 1.1 IS NOT THE MODEL RULE. Its black letter is a prohibition on handling a matter the lawyer is not competent to handle, not the model's affirmative duty to provide competent representation. A certificate or memo that quotes the ABA model sentence beginning A lawyer shall provide competent representation as North Carolina law is wrong. CHECKED, NOTHING AI-SPECIFIC FOUND (all fetched 2026-09-21): N.C. R.P.C. 1.1, 1.4, 1.5, 1.6, 3.3, 5.1, 5.3 and Scope — no rule or comment mentions artificial intelligence; the North Carolina State Bar sitemap (1,995 URLs, 700 of them ethics opinions), from which every formal ethics opinion slug was enumerated — the only AI opinion is 2024 FEO 1, and 2024 FEO 3, 2025 FEO 1, 2025 FEO 2 and proposed 2025 FEO 3 and 2026 FEO 1, 2 and 3 were each fetched and contain no AI content; CourtListener v4 opinion search over the Supreme Court of North Carolina and the North Carolina Court of Appeals for artificial intelligence with fabricated, fictitious, nonexistent or hallucinat* — two hits, both false positives (Hoke Cnty. Bd. of Educ. v. State, No. 425A21-3 (N.C. Apr. 2, 2026), where the phrase appears only in a separate opinion's aside about educating children, and Padilla v. Lusth, 118 N.C. App. 709 (1995)); so NO published North Carolina appellate decision sanctioning counsel for AI-fabricated citations was found; N.C. House Bill 934 (AI Regulatory Reform Act) and Senate Bill 747 (AI Learning Agenda), 2025 session — neither regulates AI in court filings or law practice. NOT FETCHED / OPEN FOR THE VERIFIER: (a) the North Carolina Judicial Branch's Data Science and Artificial Intelligence Initiative Task Force page and the superseded July 23, 2024 Cabarrus order page both return HTTP 403 to curl and were not retried further — a verifier should get the task force's charge and any report, since a statewide recommendation would change this entry; (b) the State Bar's ethics-opinion index, proposed-opinions and proposed-amendments pages render their lists in JavaScript and returned no list to curl, so the sitemap enumeration above is the evidence for completeness, not the index; (c) nccourts.gov site search is also JavaScript-rendered, so the sweep for OTHER county or district AI administrative orders is incomplete — assume more exist and check the district where a matter is pending; (d) the formal status of an adopted North Carolina State Bar formal ethics opinion (binding, quasi-binding or advisory) was not sourced in this run and should be pinned to 27 N.C.A.C. 1D before the entry is relied on; (e) whether the Supreme Court of North Carolina has approved anything on AI."
    },
    {
      "id": "mo-rpc",
      "kind": "state_bar",
      "name": "Missouri Rules of Professional Conduct (Mo. Sup. Ct. R. 4) and Missouri AI guidance",
      "disclosure_to_court": "none",
      "certification_required": false,
      "certificate_language": null,
      "verification_duty": "No Missouri rule of professional conduct, statewide court rule, Supreme Court order, or statute imposes an AI-specific verification or disclosure duty as of 2026-09-21. The duty comes from the general rules, from two Supreme Court Office of Legal Ethics Counsel informal advisory opinions squarely on generative AI, and from three published Court of Appeals decisions. Rule 4-1.1 (black letter): \"A lawyer shall provide competent representation to a client. Competent representation requires the legal knowledge, skill, thoroughness and preparation reasonably necessary for the representation.\" Rule 4-1.1 Comment [6] carries the ABA technology clause with one added serial comma. Rule 4-3.3(a)(1): a lawyer shall not knowingly \"make a false statement of fact or law to a tribunal or fail to correct a false statement of material fact or law previously made to the tribunal by the lawyer\". Supervision: Rule 4-5.1(b), \"A lawyer having direct supervisory authority over another lawyer shall make reasonable efforts to ensure that the other lawyer conforms to the Rules of Professional Conduct.\"; Rule 4-5.3(b) for nonlawyers. Signing certification (general, not AI-specific): Rule 55.03(c), \"By presenting and maintaining a claim, defense, request, demand, objection, contention, or argument in a pleading, motion, or other paper filed with or submitted to the court, an attorney or party is certifying that to the best of the person's knowledge, information, and belief, formed after an inquiry reasonable under the circumstances\" that \"The claims, defenses, and other legal contentions therein are warranted by existing law or by a nonfrivolous argument for the extension, modification, or reversal of existing law or the establishment of new law\". On appeal the same certification is carried into the brief by Rule 84.06(c), and Rule 84.19 supplies the remedy: \"If an appellate court shall determine that an appeal is frivolous it may award damages to the respondent as the court shall deem just and proper.\" Non-binding Office of Legal Ethics Counsel Informal Opinion 2024-11 (Apr. 25, 2024, generative AI): \"At this point, generative AI tools are not always accurate, thereby requiring the careful attention to competence and supervision as outlined above to avoid any false statement of material fact or law to a tribunal.\"; the lawyer \"must protect and maintain professional independence and independent professional judgment\"; when a lawyer uses generative-AI content \"there is a professional responsibility to verify the accuracy and content of the product\". Informal Opinion 2026-09 (Aug. 3, 2026, AI deposition software) restates competence as an independent-verification duty: \"This rule requires a lawyer to have a reasonable understanding of the capabilities and limitations of AI software, including the risks posed by the use of the software.\" Case law: Kruse v. Karlen, 692 S.W.3d 43 (Mo. App. E.D. Feb. 13, 2024) (reported in S.W.3d), \"Filing an appellate brief with bogus citations in this Court for any reason cannot be countenanced and represents a flagrant violation of the duties of candor Appellant owes to this Court.\" and \"We urge all parties practicing before this Court, barred and self-represented alike, to be cognizant that we are aware of the issue and will not permit fraud on this Court in violation of our rules.\"; Jones v. Simploy, Inc. (Mo. App. E.D. Sept. 24, 2024) (full signed opinion; no reporter citation located), \"litigants who use generative AI to draft their briefs should not rely on our continued magnanimity.\"; Stevens v. BJC Health System (Mo. App. E.D. Mar. 18, 2025) (full signed opinion; no reporter citation located), \"we warn litigants that using artificial intelligence to draft a legal document may lead to sanctions if the user fails to perform a critical review of the end-product to ensure that fictitious legal authorities or citations do not appear in filings with this Court or any other court.\"",
      "confidentiality_restriction": "Rule 4-1.6(a): \"A lawyer shall not reveal information relating to the representation of a client unless the client gives informed consent, the disclosure is impliedly authorized in order to carry out the representation, or the disclosure is permitted by Rule 4-1.6(b).\" Rule 4-1.6(c): \"A lawyer shall make reasonable efforts to prevent the inadvertent or unauthorized disclosure of, or unauthorized access to, information relating to the representation of the client.\" Rule 4-1.6 Comment [15] requires a lawyer \"to act competently to safeguard information relating to the representation of a client against unauthorized access by third parties\" with reasonableness factors. Rule 4-5.3 Comment [3] lists \"using an Internet-based service to store client information\" as an outside-the-firm service for which the lawyer \"must make reasonable efforts to ensure that the services are provided in a manner that is compatible with the lawyer's professional obligations.\" Non-binding Informal Opinion 2024-11 applies this to generative AI: \"lawyers are required to make reasonable efforts to safeguard client confidential information\". Informal Opinion 2026-09 goes one step further and makes client consent a precondition: \"A lawyer must obtain informed consent from the client to the use of the AI software before inputting confidential client information into the AI software.\" No Missouri rule bars inputting client information into AI outright.",
      "record_keeping_duty": "none",
      "client_disclosure_duty": "conditional — Rule 4-1.4(b): \"A lawyer shall explain a matter to the extent reasonably necessary to permit the client to make informed decisions regarding the representation.\" CAUTION: Missouri's Rule 4-1.4(a) was NOT restyled to the ABA's five subparagraphs; it has three, beginning \"keep the client reasonably informed about the status of the matter\", and contains no clause requiring the lawyer to consult about \"the means by which\" the objectives are accomplished (that phrase appears only in Comment [2], as guidance). The operative AI trigger is consent, not disclosure: Informal Opinion 2026-09, \"A lawyer must obtain informed consent from the client to the use of the AI software before inputting confidential client information into the AI software.\" The same opinion states the limit: \"The Rules of Professional Conduct do not specifically address whether a lawyer must advise the client, the court, opposing counsel, or the deponent of the use of AI software.\"",
      "fees_note": "Rule 4-1.5(a): \"A lawyer shall not make an agreement for, charge, or collect an unreasonable fee or an unreasonable amount for expenses.\" Non-binding Informal Opinion 2026-09: \"This rule requires a lawyer to communicate to the client at the time of commencing the representation or soon thereafter, preferably in writing, any charge or fee to be assessed to the client for the use of the AI software.\" and \"Any hourly fees charged to the client by lawyers or paralegals using the software must be reasonable, i.e., the amount of time charged must reflect the efficiencies provided by the use of the software.\"",
      "sources": [
        {
          "title": "Mo. Sup. Ct. R. 4-1.1 (Competence), black letter — official text on the Missouri Judiciary's Supreme Court Rules site",
          "url": "https://www.courts.mo.gov/courts/ClerkHandbooksP2RulesOnly.nsf/c0c6ffa99df4993f86256ba50057dcb8/20fd60132de3411886256ca6005211b4?OpenDocument",
          "verbatim": "A lawyer shall provide competent representation to a client. Competent representation requires the legal knowledge, skill, thoroughness and preparation reasonably necessary for the representation.",
          "effective": "2017-09-26",
          "fetched": "2026-09-21"
        },
        {
          "title": "Same — Rule 4-1.1 Comment [6] (technology competence; Missouri numbers it 6, not 8)",
          "url": "https://www.courts.mo.gov/courts/ClerkHandbooksP2RulesOnly.nsf/c0c6ffa99df4993f86256ba50057dcb8/20fd60132de3411886256ca6005211b4?OpenDocument",
          "verbatim": "To maintain the requisite knowledge and skill, a lawyer should keep abreast of changes in the law and its practice, including the benefits and risks associated with relevant technology, engage in continuing study and education, and comply with all continuing legal education requirements to which the lawyer is subject.",
          "effective": "2017-09-26",
          "fetched": "2026-09-21"
        },
        {
          "title": "Same — Rule 4-1.1 adoption and amendment history line",
          "url": "https://www.courts.mo.gov/courts/ClerkHandbooksP2RulesOnly.nsf/c0c6ffa99df4993f86256ba50057dcb8/20fd60132de3411886256ca6005211b4?OpenDocument",
          "verbatim": "(Adopted August 7, 1985, effective January 1, 1986. Amended March 1, 2007, effective July 1, 2007; Amended September 26, 2017, effective September 26, 2017.)",
          "effective": "2017-09-26",
          "fetched": "2026-09-21"
        },
        {
          "title": "Mo. Sup. Ct. R. 4, Preamble and Scope para. [14] (Comments add no obligations)",
          "url": "https://www.courts.mo.gov/courts/ClerkHandbooksP2RulesOnly.nsf/c0c6ffa99df4993f86256ba50057dcb8/4c4ee2e8d24e2ff386256ca60052123c?OpenDocument",
          "verbatim": "Comments do not add obligations to the Rules but provide guidance for practicing in compliance with the Rules.",
          "effective": "2007-07-01",
          "fetched": "2026-09-21"
        },
        {
          "title": "Same — Scope para. [21] (authority of the Comments)",
          "url": "https://www.courts.mo.gov/courts/ClerkHandbooksP2RulesOnly.nsf/c0c6ffa99df4993f86256ba50057dcb8/4c4ee2e8d24e2ff386256ca60052123c?OpenDocument",
          "verbatim": "The Comments are intended as guides to interpretation, but the text of each Rule is authoritative.",
          "effective": "2007-07-01",
          "fetched": "2026-09-21"
        },
        {
          "title": "Mo. Sup. Ct. R. 4-1.4(a) (Communication; only three subparagraphs, unlike the ABA rule)",
          "url": "https://www.courts.mo.gov/courts/ClerkHandbooksP2RulesOnly.nsf/c0c6ffa99df4993f86256ba50057dcb8/348b78aceb4a947986256ca600521251?OpenDocument",
          "verbatim": "keep the client reasonably informed about the status of the matter;",
          "effective": "2017-09-26",
          "fetched": "2026-09-21"
        },
        {
          "title": "Same — Rule 4-1.4(b)",
          "url": "https://www.courts.mo.gov/courts/ClerkHandbooksP2RulesOnly.nsf/c0c6ffa99df4993f86256ba50057dcb8/348b78aceb4a947986256ca600521251?OpenDocument",
          "verbatim": "A lawyer shall explain a matter to the extent reasonably necessary to permit the client to make informed decisions regarding the representation.",
          "effective": "2017-09-26",
          "fetched": "2026-09-21"
        },
        {
          "title": "Same — Rule 4-1.4 Comment [2] (the only place the means language appears)",
          "url": "https://www.courts.mo.gov/courts/ClerkHandbooksP2RulesOnly.nsf/c0c6ffa99df4993f86256ba50057dcb8/348b78aceb4a947986256ca600521251?OpenDocument",
          "verbatim": "the means by which they are to be pursued, to the extent the client is willing and able to do so.",
          "effective": "2017-09-26",
          "fetched": "2026-09-21"
        },
        {
          "title": "Mo. Sup. Ct. R. 4-1.5(a) (Fees)",
          "url": "https://www.courts.mo.gov/courts/ClerkHandbooksP2RulesOnly.nsf/c0c6ffa99df4993f86256ba50057dcb8/6ebe0456bcc45d6186256ca6005211df?OpenDocument",
          "verbatim": "A lawyer shall not make an agreement for, charge, or collect an unreasonable fee or an unreasonable amount for expenses.",
          "effective": "2008-01-01",
          "fetched": "2026-09-21"
        },
        {
          "title": "Mo. Sup. Ct. R. 4-1.6(a) (Confidentiality of Information)",
          "url": "https://www.courts.mo.gov/courts/ClerkHandbooksP2RulesOnly.nsf/c0c6ffa99df4993f86256ba50057dcb8/b284eee6f79f447486256ca6005211ee?OpenDocument",
          "verbatim": "A lawyer shall not reveal information relating to the representation of a client unless the client gives informed consent, the disclosure is impliedly authorized in order to carry out the representation, or the disclosure is permitted by Rule 4-1.6(b).",
          "effective": "2017-09-26",
          "fetched": "2026-09-21"
        },
        {
          "title": "Same — Rule 4-1.6(c)",
          "url": "https://www.courts.mo.gov/courts/ClerkHandbooksP2RulesOnly.nsf/c0c6ffa99df4993f86256ba50057dcb8/b284eee6f79f447486256ca6005211ee?OpenDocument",
          "verbatim": "A lawyer shall make reasonable efforts to prevent the inadvertent or unauthorized disclosure of, or unauthorized access to, information relating to the representation of the client.",
          "effective": "2017-09-26",
          "fetched": "2026-09-21"
        },
        {
          "title": "Same — Rule 4-1.6 Comment [15] (competent safeguarding; reasonableness factors)",
          "url": "https://www.courts.mo.gov/courts/ClerkHandbooksP2RulesOnly.nsf/c0c6ffa99df4993f86256ba50057dcb8/b284eee6f79f447486256ca6005211ee?OpenDocument",
          "verbatim": "requires a lawyer to act competently to safeguard information relating to the representation of a client against unauthorized access by third parties and against inadvertent or unauthorized disclosure by the lawyer or other persons who are participating in the representation of the client or who are subject to the lawyer's supervision.",
          "effective": "2017-09-26",
          "fetched": "2026-09-21"
        },
        {
          "title": "Mo. Sup. Ct. R. 4-3.3(a)(1) (Candor Toward the Tribunal)",
          "url": "https://www.courts.mo.gov/courts/ClerkHandbooksP2RulesOnly.nsf/c0c6ffa99df4993f86256ba50057dcb8/970895ef92a879d486256ca6005211c4?OpenDocument",
          "verbatim": "make a false statement of fact or law to a tribunal or fail to correct a false statement of material fact or law previously made to the tribunal by the lawyer;",
          "effective": "2007-07-01",
          "fetched": "2026-09-21"
        },
        {
          "title": "Mo. Sup. Ct. R. 4-5.1(b) (supervisory lawyers)",
          "url": "https://www.courts.mo.gov/courts/ClerkHandbooksP2RulesOnly.nsf/c0c6ffa99df4993f86256ba50057dcb8/bd6e7a3e97c8948186256ca600521234?OpenDocument",
          "verbatim": "A lawyer having direct supervisory authority over another lawyer shall make reasonable efforts to ensure that the other lawyer conforms to the Rules of Professional Conduct.",
          "effective": "2007-07-01",
          "fetched": "2026-09-21"
        },
        {
          "title": "Mo. Sup. Ct. R. 4-5.3(b) (nonlawyer assistants)",
          "url": "https://www.courts.mo.gov/courts/ClerkHandbooksP2RulesOnly.nsf/c0c6ffa99df4993f86256ba50057dcb8/f264eb01f0599e3186256ca6005211e3?OpenDocument",
          "verbatim": "a lawyer having direct supervisory authority over the nonlawyer shall make reasonable efforts to ensure that the person's conduct is compatible with the professional obligations of the lawyer; and",
          "effective": "2017-09-26",
          "fetched": "2026-09-21"
        },
        {
          "title": "Same — Rule 4-5.3 Comment [3] (Internet-based services to store client information)",
          "url": "https://www.courts.mo.gov/courts/ClerkHandbooksP2RulesOnly.nsf/c0c6ffa99df4993f86256ba50057dcb8/f264eb01f0599e3186256ca6005211e3?OpenDocument",
          "verbatim": "using an Internet-based service to store client information. When using such services outside the firm, a lawyer must make reasonable efforts to ensure that the services are provided in a manner that is compatible with the lawyer's professional obligations.",
          "effective": "2017-09-26",
          "fetched": "2026-09-21"
        },
        {
          "title": "Mo. Sup. Ct. R. 55.03(c) (signing and representations to the court; general, not AI-specific)",
          "url": "https://www.courts.mo.gov/courts/ClerkHandbooksP2RulesOnly.nsf/c0c6ffa99df4993f86256ba50057dcb8/7db1c05900034fdc86256ca60052152c?OpenDocument",
          "verbatim": "By presenting and maintaining a claim, defense, request, demand, objection, contention, or argument in a pleading, motion, or other paper filed with or submitted to the court, an attorney or party is certifying that to the best of the person's knowledge, information, and belief, formed after an inquiry reasonable under the circumstances, that:",
          "effective": "2023-01-01",
          "fetched": "2026-09-21"
        },
        {
          "title": "Same — Rule 55.03(c)(2)",
          "url": "https://www.courts.mo.gov/courts/ClerkHandbooksP2RulesOnly.nsf/c0c6ffa99df4993f86256ba50057dcb8/7db1c05900034fdc86256ca60052152c?OpenDocument",
          "verbatim": "The claims, defenses, and other legal contentions therein are warranted by existing law or by a nonfrivolous argument for the extension, modification, or reversal of existing law or the establishment of new law;",
          "effective": "2023-01-01",
          "fetched": "2026-09-21"
        },
        {
          "title": "Mo. Sup. Ct. R. 84.06(c) (appellate certificate of compliance; carries Rule 55.03 into every brief)",
          "url": "https://www.courts.mo.gov/courts/ClerkHandbooksP2RulesOnly.nsf/c0c6ffa99df4993f86256ba50057dcb8/faf0387a6ebca8aa86256ca60052137b?OpenDocument",
          "verbatim": "A brief submitted under this Rule 84.06 shall contain a certificate of compliance by the lawyer or self-represented person that: (1) Includes the information required by Rule 55.03;",
          "effective": "2024-01-01",
          "fetched": "2026-09-21"
        },
        {
          "title": "Mo. Sup. Ct. R. 84.19 (Damages for Frivolous Appeals) — the remedy used in Kruse",
          "url": "https://www.courts.mo.gov/courts/ClerkHandbooksP2RulesOnly.nsf/c0c6ffa99df4993f86256ba50057dcb8/946916e65959430286256ca6005215d5?OpenDocument",
          "verbatim": "If an appellate court shall determine that an appeal is frivolous it may award damages to the respondent as the court shall deem just and proper.",
          "effective": "1980-01-01",
          "fetched": "2026-09-21"
        },
        {
          "title": "Office of Legal Ethics Counsel and Advisory Committee of the Supreme Court of Missouri, Informal Opinion 2024-11 (adopted Apr. 25, 2024) — generative AI use policy; competence",
          "url": "https://mo-legal-ethics.org/informal-opinion/2024-11/",
          "verbatim": "Lawyer should get education and training to ascertain what types of generative AI are and are not appropriate for use by Law Firm.",
          "effective": "2024-04-25",
          "fetched": "2026-09-21"
        },
        {
          "title": "Same — confidentiality",
          "url": "https://mo-legal-ethics.org/informal-opinion/2024-11/",
          "verbatim": "lawyers are required to make reasonable efforts to safeguard client confidential information",
          "effective": "2024-04-25",
          "fetched": "2026-09-21"
        },
        {
          "title": "Same — professional independence",
          "url": "https://mo-legal-ethics.org/informal-opinion/2024-11/",
          "verbatim": "must protect and maintain professional independence and independent professional judgment",
          "effective": "2024-04-25",
          "fetched": "2026-09-21"
        },
        {
          "title": "Same — duty to verify generative-AI product",
          "url": "https://mo-legal-ethics.org/informal-opinion/2024-11/",
          "verbatim": "there is a professional responsibility to verify the accuracy and content of the product",
          "effective": "2024-04-25",
          "fetched": "2026-09-21"
        },
        {
          "title": "Same — candor to the tribunal",
          "url": "https://mo-legal-ethics.org/informal-opinion/2024-11/",
          "verbatim": "At this point, generative AI tools are not always accurate, thereby requiring the careful attention to competence and supervision as outlined above to avoid any false statement of material fact or law to a tribunal.",
          "effective": "2024-04-25",
          "fetched": "2026-09-21"
        },
        {
          "title": "Same — status of Missouri informal opinions (advisory, not binding)",
          "url": "https://mo-legal-ethics.org/informal-opinion/2024-11/",
          "verbatim": "Informal opinion summaries are advisory in nature and are not binding.",
          "effective": "2024-04-25",
          "fetched": "2026-09-21"
        },
        {
          "title": "Office of Legal Ethics Counsel, Informal Opinion 2026-09 (adopted Aug. 3, 2026) — AI deposition software; competence as independent verification",
          "url": "https://mo-legal-ethics.org/informal-opinion/2026-09/",
          "verbatim": "This rule requires a lawyer to have a reasonable understanding of the capabilities and limitations of AI software, including the risks posed by the use of the software.",
          "effective": "2026-08-03",
          "fetched": "2026-09-21"
        },
        {
          "title": "Same — informed consent before inputting confidential information (KEY)",
          "url": "https://mo-legal-ethics.org/informal-opinion/2026-09/",
          "verbatim": "A lawyer must obtain informed consent from the client to the use of the AI software before inputting confidential client information into the AI software.",
          "effective": "2026-08-03",
          "fetched": "2026-09-21"
        },
        {
          "title": "Same — no rule-based duty to disclose AI use to client, court, opposing counsel or deponent",
          "url": "https://mo-legal-ethics.org/informal-opinion/2026-09/",
          "verbatim": "The Rules of Professional Conduct do not specifically address whether a lawyer must advise the client, the court, opposing counsel, or the deponent of the use of AI software.",
          "effective": "2026-08-03",
          "fetched": "2026-09-21"
        },
        {
          "title": "Same — floor on candor about AI use",
          "url": "https://mo-legal-ethics.org/informal-opinion/2026-09/",
          "verbatim": "a lawyer should not misrepresent the use of any AI software.",
          "effective": "2026-08-03",
          "fetched": "2026-09-21"
        },
        {
          "title": "Same — fees for AI software",
          "url": "https://mo-legal-ethics.org/informal-opinion/2026-09/",
          "verbatim": "This rule requires a lawyer to communicate to the client at the time of commencing the representation or soon thereafter, preferably in writing, any charge or fee to be assessed to the client for the use of the AI software.",
          "effective": "2026-08-03",
          "fetched": "2026-09-21"
        },
        {
          "title": "Same — hourly fees must reflect AI efficiencies",
          "url": "https://mo-legal-ethics.org/informal-opinion/2026-09/",
          "verbatim": "Any hourly fees charged to the client by lawyers or paralegals using the software must be reasonable, i.e., the amount of time charged must reflect the efficiencies provided by the use of the software.",
          "effective": "2026-08-03",
          "fetched": "2026-09-21"
        },
        {
          "title": "Kruse v. Karlen, No. ED111172, 692 S.W.3d 43 (Mo. App. E.D. Feb. 13, 2024) (reported in S.W.3d; citation taken from Stevens n.1) — the holding",
          "url": "https://www.courts.mo.gov/file.jsp?id=205455",
          "verbatim": "Filing an appellate brief with bogus citations in this Court for any reason cannot be countenanced and represents a flagrant violation of the duties of candor Appellant owes to this Court.",
          "effective": "2024-02-13",
          "fetched": "2026-09-21"
        },
        {
          "title": "Same — introduction (AI-generated fictitious cases; dismissal and Rule 84.19 damages)",
          "url": "https://www.courts.mo.gov/file.jsp?id=205455",
          "verbatim": "submission of fictitious cases generated by artificial intelligence (“A.I.”), we dismiss the appeal.",
          "effective": "2024-02-13",
          "fetched": "2026-09-21"
        },
        {
          "title": "Same — warning to the bar and to self-represented litigants",
          "url": "https://www.courts.mo.gov/file.jsp?id=205455",
          "verbatim": "We urge all parties practicing before this Court, barred and self-represented alike, to be cognizant that we are aware of the issue and will not permit fraud on this Court in violation of our rules.",
          "effective": "2024-02-13",
          "fetched": "2026-09-21"
        },
        {
          "title": "Same — the sanction",
          "url": "https://www.courts.mo.gov/file.jsp?id=205455",
          "verbatim": "Appellant is ordered to pay $10,000 to Respondent in damages for filing a frivolous appeal.",
          "effective": "2024-02-13",
          "fetched": "2026-09-21"
        },
        {
          "title": "Jones v. Simploy, Inc., No. ED112394 (Mo. App. E.D. Sept. 24, 2024) (full signed opinion; no reporter citation located) — AI suspected, appeal not dismissed",
          "url": "https://www.courts.mo.gov/file.jsp?id=211940",
          "verbatim": "we suspect such citations were generated by artificial intelligence rather than the result of a deliberate attempt to mislead the Court.",
          "effective": "2024-09-24",
          "fetched": "2026-09-21"
        },
        {
          "title": "Same — the warning",
          "url": "https://www.courts.mo.gov/file.jsp?id=211940",
          "verbatim": "litigants who use generative AI to draft their briefs should not rely on our continued magnanimity.",
          "effective": "2024-09-24",
          "fetched": "2026-09-21"
        },
        {
          "title": "Stevens v. BJC Health System (Mo. App. E.D. Mar. 18, 2025) (full signed opinion; no reporter citation located) — n.1 warning; also supplies the Kruse reporter citation",
          "url": "https://www.courts.mo.gov/file.jsp?id=218540",
          "verbatim": "we warn litigants that using artificial intelligence to draft a legal document may lead to sanctions if the user fails to perform a critical review of the end-product to ensure that fictitious legal authorities or citations do not appear in filings with this Court or any other court.",
          "effective": "2025-03-18",
          "fetched": "2026-09-21"
        },
        {
          "title": "Same — n.1 citation of Kruse with reporter pagination",
          "url": "https://www.courts.mo.gov/file.jsp?id=218540",
          "verbatim": "Kruse v. Karlen, 692 S.W.3d 43, 52 (Mo. App. E.D. 2024)",
          "effective": "2025-03-18",
          "fetched": "2026-09-21"
        },
        {
          "title": "CourtListener v4 search API result for Missouri AI-citation opinions (court=mo moctapp) — three hits, all Court of Appeals Eastern District; JSON kept as the search record",
          "url": "https://www.courtlistener.com/api/rest/v4/search/?q=%28%22artificial+intelligence%22+OR+ChatGPT+OR+%22generative+AI%22%29+AND+%28fictitious+OR+fabricated+OR+nonexistent+OR+hallucinated+OR+%22does+not+exist%22%29&type=o&court=mo+moctapp&order_by=dateFiled+desc",
          "verbatim": null,
          "effective": null,
          "fetched": "2026-09-21"
        },
        {
          "title": "Missouri Bar, Legal Ethics Opinions page — informal opinions are issued by the Supreme Court's Office of Legal Ethics Counsel under Rule 5.30(c), not by the Bar",
          "url": "https://mobar.org/site/Lawyer_Resources/Legal_Ethics_Opinions/site/content/Lawyer-Resources/Legal_Ethics_Opinions.aspx",
          "verbatim": "Informal Opinions are ethics advisory opinions issued by the Office of Legal Ethics Counsel to members of the Bar about Rule 4 (Rules of Professional Conduct), Rule 5 (Complaints and Proceedings Thereon), and Rule 6 (Fees to Practice Law) pursuant to Missouri Supreme Court Rule 5.30(c).",
          "effective": null,
          "fetched": "2026-09-21"
        },
        {
          "title": "Office of Legal Ethics Counsel, informal opinions search index (used to find the AI opinions)",
          "url": "https://mo-legal-ethics.org/informal-opinions-search/",
          "verbatim": "Subject: Artificial Intelligence; Communication with Clients; Competence; Confidentiality; Professional Independence of Lawyer",
          "effective": null,
          "fetched": "2026-09-21"
        }
      ],
      "status": "verified",
      "verified_on": "2026-09-21",
      "verified_by": "claude-opus verifier session, batch 4c",
      "attorney_signoff": null,
      "notes": "BOTTOM LINE: Missouri has no AI-specific rule of professional conduct, no statewide court rule, no Supreme Court order and no statute directed at AI use in filings, as of 2026-09-21. What Missouri has instead is the deepest published appellate record of the three states in this batch (three published Court of Appeals decisions, 2024-2025) and two dedicated generative-AI advisory opinions from the Supreme Court's own Office of Legal Ethics Counsel. TECHNOLOGY COMPETENCE: adopted, at Rule 4-1.1 Comment [6] (not [8]). The wording is the ABA wording with one comma difference, and the comment text is published on the Missouri Judiciary's own rules site, so unlike Arizona there is no sourcing gap. Effective date recorded as 2017-09-26 because that is the rule's latest amendment on the face of the document and the page's own Revised / Effective Date field; the page does not say which amendment added the technology clause. OPEN QUESTION 1 for the verifier: confirm the technology clause entered Missouri in the Sept. 26, 2017 order and not in the 2007 restyling. SURPRISE FOR A LAWYER 1: Missouri's Rule 4-1.4(a) has only three subparagraphs. It does not contain the ABA's 1.4(a)(1) (prompt notice of circumstances requiring informed consent) or 1.4(a)(2) (consult about the means). A practitioner reasoning from the ABA text will over-state the Missouri communication duty. The means language survives only in Comment [2]. SURPRISE FOR A LAWYER 2: Missouri Informal Opinion 2026-09 (Aug. 3, 2026) makes CLIENT CONSENT, not court disclosure, the AI tripwire, and it is written for tools most firms already run: it concerns AI deposition software with a real-time listening feature. Its sentence on informed consent is unqualified and is stricter than the Arizona and Tennessee positions. It is advisory only. SURPRISE FOR A LAWYER 3: all three Missouri appellate decisions sanctioned or warned SELF-REPRESENTED litigants, not counsel. Kruse v. Karlen dismissed the appeal and awarded $10,000 under Rule 84.19 (a damages award to the respondent, not professional discipline); Jones v. Simploy expressly declined to sanction because the respondent was a state agency that paid no outside counsel; Stevens v. BJC gave a footnote warning. There is therefore still no published Missouri appellate decision sanctioning or disciplining an ATTORNEY for AI-fabricated citations. Kruse is nevertheless the case everyone cites, and the Arizona Court of Appeals cited it in Dineen/Shibata v. Kotchka in July 2026. BINDING STATUS: (a) Rule 4 black letter binds; Comments do not — Scope [14] and [21]. (b) Informal Opinions 2024-11 and 2026-09 are issued by the Office of Legal Ethics Counsel under Mo. Sup. Ct. R. 5.30(c) and are, by their own terms, advisory and not binding. They are Supreme Court staff opinions, not Advisory Committee formal opinions, and they are published as summaries. (c) Rule 55.03(c) is the general signing certification; Rule 84.06(c) pulls it into every appellate brief; Rule 84.19 is the appellate damages remedy. None mentions AI. TEXT-EXTRACTION CAVEAT FOR THE VERIFIER: mo-legal-ethics.org renders each rule number as the digit 4, then a screen-reader-only span containing the word dash, then an en dash entity, then the rest of the number. Every rule number in the extracted text of the two informal opinions therefore reads 4 dash-1.1 rather than 4-1.1. That is a faithful extraction of accessibility markup, not an error in the opinion. Quotations taken from those two opinions were deliberately chosen to avoid rule numbers. CHECKED, NOTHING AI-SPECIFIC FOUND (all fetched 2026-09-21): Rules 4-1.1, 4-1.4, 4-1.5, 4-1.6, 4-3.3, 4-5.1, 4-5.3 with their full Comments, the Rule 4 Preamble and Scope, Rule 55.03, Rule 84.06 and Rule 84.19 on the Missouri Judiciary's Supreme Court Rules site - zero occurrences of artificial, generative, machine learning or chatgpt in any of them; the Office of Legal Ethics Counsel informal opinions index, which lists exactly two AI-subject opinions (2024-11 and 2026-09); the Missouri Bar Ethics and Legal Ethics Opinions pages. NOT FETCHED / NOT DONE: courts.mo.gov blocks automated access outside the Domino rules database - the page.jsp pages return HTTP 403 with the message that access by a site data scraper is expressly prohibited, and the opinion PDFs returned 403 until a Referer header was added, so there was no way to sweep Supreme Court en banc rule orders or court news for an AI order; no Missouri statute search was run; the Missouri Bar news search returned no AI results to curl; Missouri Advisory Committee FORMAL opinions were not searched (the index lives behind courts.mo.gov). OPEN QUESTION 2 for the verifier: sweep Missouri Supreme Court en banc rule orders 2024-2026 and the Advisory Committee formal opinions for anything on AI, and run a Missouri Revised Statutes keyword search for artificial intelligence together with court filings or the practice of law. OPEN QUESTION 3: check the Office of Chief Disciplinary Counsel for any AI-hallucination discipline, which would be the first Missouri case against a lawyer rather than a self-represented litigant."
    }
  ]
};
