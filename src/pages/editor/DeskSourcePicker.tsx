// Pull a manuscript from Contextspaces onto the Editor's desk — the shared
// CorpusDocumentPicker, seated on the desk.

import CorpusDocumentPicker from '@/components/matter/CorpusDocumentPicker';

type Props = {
  onCancel: () => void;
  /**
   * `matterId` travels with the text: the Editor sends whole manuscripts to a
   * model, and a manuscript pulled out of a matter is that matter's content.
   * Null when the document has no matter.
   */
  onLoaded: (text: string, title: string, matterId: string | null) => void;
};

export default function DeskSourcePicker({ onCancel, onLoaded }: Props) {
  return (
    <CorpusDocumentPicker
      deskAligned
      onCancel={onCancel}
      onPicked={(p) => onLoaded(p.text, p.title, p.matterId)}
    />
  );
}
