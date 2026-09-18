> **DRAFT — not for publication until Eden has read it end to end and verified the two case references (Heppner; Victor Stanley) against the opinions.** Drafted 2026-09-18 from strategy memo 006. Byline and venue to be decided.

# Your AI does not know which of your files are privileged

Most lawyers who use an AI assistant have a rule. Nothing privileged goes into the tool. The client's emails, the strategy memo, the notes from the call where the client told you the part they had not told anyone else: those stay in a separate folder, and the assistant gets the public record, the filed papers, the research.

The rule is the right instinct applied at the wrong layer. It governs what you paste. It does not govern what the assistant can reach, and the assistant can reach more than you think.

## What actually happens

Take an ordinary afternoon. You are working on a brief in an AI project that holds only public material. You remember a settlement the firm negotiated a few years ago in a similar case, and you ask the assistant to search your document store for it. The assistant calls the connector, the connector runs a search across your files, and the results come back into the conversation: snippets of everything that matched the word "settlement," including a privileged memo from a different client. You have not read anything yet. You have not added anything to the project. The memo's text is already in the conversation, and the conversation has already been sent to the provider.

Then you find the filed precedent you wanted, add it to the project, and ask the assistant to search the web for public settlement figures in your state. It writes a query. The query is composed from what is in front of it. Usually it is generic. Sometimes it is not, and the number from the memo goes to a search engine that keeps logs. Nothing but the model's judgment stood between the two.

Neither step was a breach. Both were features working as designed. The assistant's job is to bring the most relevant text to bear on your question, and the most relevant text on a legal question in your files is very often the privileged analysis.

## Three ways it goes wrong

The first is disclosure to the wrong party. An assistant with an email tool, asked to send opposing counsel the meet-and-confer letter, attaches what it believes is the letter. If the draft still carries the internal comments, or it summarizes your position "helpfully" in the body, the privileged content reaches the adversary. Courts treat inadvertent production under a reasonableness standard, and "the assistant selected it and I skimmed" is not a precaution.

The second is mixing. A non-privileged letter drafted with the strategy memo in context will contain a sentence that only exists in the memo. A deposition summary written with your annotated copy in context will adopt your mental impressions as if the witness said them. The output looks neutral. Its content is not.

The third is memory. An assistant that remembers across conversations will surface one client's facts while you work on another's. No waiver, but a conflicts problem, and if you are a screened lawyer, the end of the screen.

## The client's side is worse

Clients think before they call. Increasingly they think in a chatbot: paste the lawyer's advice email, write out the timeline including the part they are embarrassed about, ask how bad it really is. This February a federal judge in Manhattan held that a defendant's exchanges with a generative-AI platform were protected neither by attorney-client privilege nor by work product. The client is not a lawyer, the chatbot is not the lawyer's agent, and nothing about it was confidential. In discovery, those chats are exhibits. The client's own worst assessment of the case, in the client's own words, and the lawyer's advice, disclosed to a third party by the person it was meant to protect.

Nothing the lawyer did was wrong. The client had no privileged place to think.

## What zero retention does and does not do

Vendors advertise zero data retention and no training. Both are worth having. Zero retention means there is no copy at the vendor to subpoena, to breach, or for a vendor's staff to read, and it is the strongest evidence you can offer that you took reasonable steps. But it does not stop the assistant from mixing your privileged memo into a public letter, and it does not stop a search query from carrying a client's number to a search engine. Retention is about what the vendor keeps. Privilege is about what leaves your circle and who can see it. Those are different questions, and the second one is decided by reach.

## The fix is structural, and it is boring

Three rules, in order of importance.

**Separate by reach, not by paste.** Privileged material lives where no connector points and no cross-matter search runs. If an assistant can search a folder, that folder is inside the assistant's world whether or not you ever add a file from it.

**No outbound tools where privileged material is.** A session that can see privileged documents should not have email, web search, or filing tools available. Not instructed to refrain. Absent, so there is nothing to call.

**Give clients a privileged place to think.** A channel the lawyer opens, inside the matter, that the lawyer receives and monitors, where the client is told that what they write is a communication to their lawyer. Under the ordinary elements, that is a privileged communication. In a consumer chatbot, it is an exhibit.

None of this requires the smartest model available. The privileged set in any matter is small, and the work on it is retrieval, quotation, comparison, and drafting help that the lawyer reviews anyway. What it requires is a model that stays inside the fence and can use tools reliably. Modest models do that well. The frontier models can do everything else, on everything else, where there is no privilege question at all.

## How we do it

Contextspaces runs sealed material in our own AWS account, on an open-weight model under a zero-retention setting we can read back from the account on demand, with no outbound tools and no retrieval across the seal. A sealed folder can sit inside an otherwise open matter, so the rest of the matter uses whatever model you like. Clients get a channel inside the matter that the lawyer receives. And the matter keeps a record: which container each document sat in, which model touched it under what terms, and what left the matter, to whom.

We do not say the platform preserves privilege. Privilege attaches through counsel's direction and confidentiality, not through software. What the platform gives you is the fence and the record of it, which is what a court, a carrier, or a client will ask for.

*This post is general information about how AI tools handle documents, not legal advice for any particular matter.*
