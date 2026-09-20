// GENERATED FILE — do not edit by hand.
//
// A build-time copy of the AI Use Record rules matrix
// (`references/jurisdictions.yaml` in the `ai-use-record` skill), matrix
// version 2026-09-17.1, converted verbatim by
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
  "matrix_version": "2026-09-17.1",
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
      "id": "ca-state-bar-guidance",
      "kind": "state_bar",
      "name": "State Bar of California — Practical Guidance on Generative AI (Nov. 2023; updated May 14, 2026) and proposed RPC comment amendments (2026)",
      "disclosure_to_court": "none",
      "certification_required": false,
      "certificate_language": null,
      "verification_duty": "Proposed Rule 1.1 Comment [2]: a lawyer must independently review, verify, and exercise professional judgment regarding any output generated by the technology; proposed Rule 3.3 Comment [3]: duty of candor includes verifying the accuracy and existence of cited authorities, including AI-generated ones.",
      "confidentiality_restriction": "Proposed Rule 1.6 Comment [2]: 'reveal' includes exposing confidential information to AI tools where it creates a material risk the information may be accessed, retained, or used inconsistently with the duty.",
      "record_keeping_duty": "none",
      "client_disclosure_duty": "conditional — proposed Rule 1.4 Comment [5]: when AI use presents a significant risk or materially affects scope, cost, manner, or decision-making",
      "sources": [
        {
          "title": "State Bar of California, Proposed Amendments to the Rules of Professional Conduct Related to AI (public comment closed May 4, 2026)",
          "url": "https://www.calbar.ca.gov/public/public-meetings-comment/public-comment/public-comment-archives/2026-public-comment/proposed-amendments-rules-professional-conduct-related-artificial-intelligence",
          "verbatim": "[3] A lawyer's duty of candor towards the tribunal includes the obligation to verify the accuracy and existence of cited authorities",
          "effective": null,
          "fetched": "2026-09-16"
        },
        {
          "title": "Clean/redline PDF of the proposed amendments",
          "url": "https://www.calbar.ca.gov/sites/default/files/portals/0/documents/publicComment/2026/Proposed-Amended-Rules-AI-clean-redline.pdf",
          "verbatim": "review, verify, and exercise professional judgment regarding any output generated by the technology",
          "effective": null,
          "fetched": "2026-09-16"
        }
      ],
      "status": "pending",
      "verified_on": "2026-09-16",
      "verified_by": "claude-fable-5-1 (redline PDF text extracted; no record-keeping language found)",
      "attorney_signoff": null,
      "notes": "Comment-level amendments, not black-letter rule text. No Board of Trustees or Supreme Court adoption found as of 2026-09-16. Applies to California-licensed lawyers only."
    },
    {
      "id": "ca-sb-574",
      "kind": "state_statute",
      "name": "California SB 574 (2025–2026) — generative AI use by attorneys, arbitrators, judicial officers",
      "disclosure_to_court": "required",
      "certification_required": true,
      "certificate_language": null,
      "verification_duty": "Proposed Bus. & Prof. Code § 6068.1(a)(3)(B): reasonable steps to verify the accuracy of AI output including all case and statutory citations, and correct erroneous or hallucinated output; proposed CCP § 128.7(b)(2)(A)–(B): no filed paper may contain a citation not personally verified by a responsible attorney.",
      "confidentiality_restriction": "Proposed § 6068.1(a)(3)(A): no confidential, personal identifying, or other nonpublic information into generative AI unless access is restricted to the attorney and persons obligated to protect it.",
      "record_keeping_duty": "none",
      "client_disclosure_duty": "consider disclosure for content provided to the public; disclosure to the court required for court submissions (§ 6068.1(a)(3)(C))",
      "sources": [
        {
          "title": "Sullivan & Cromwell memo, Sept. 11, 2026",
          "url": "https://www.sullcrom.com/insights/memo/2026/September/California-Legislature-Passes-Rules-Generative-AI-Use-Legal-Practitioners",
          "verbatim": "shall not delegate the practice of law to generative artificial intelligence",
          "effective": null,
          "fetched": "2026-09-16"
        },
        {
          "title": "Hunton memo (May 1, 2026, pre-Assembly version)",
          "url": "https://www.hunton.com/insights/publications/guardrails-for-legal-ai-what-californias-sb-574-would-require-of-attorneys-and-arbitrators",
          "verbatim": null,
          "effective": null,
          "fetched": "2026-09-16"
        }
      ],
      "status": "pending",
      "verified_on": null,
      "verified_by": null,
      "attorney_signoff": null,
      "notes": "Passed Legislature Aug. 31, 2026; Governor's deadline Sept. 30, 2026; effective date not stated in memos (generic inference Jan. 1, 2027). Bill text NOT read; two memos differ, suggesting amendment between May and August. Applies to California attorneys and California court filings. Verify bill text and enactment before use."
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
    }
  ]
};
