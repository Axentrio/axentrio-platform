import React, { useState } from 'react';
import { Modal } from '@/components/Modal';
import FaqContent from './FaqContent';

interface HelpFaqDialogProps {
  isOpen: boolean;
  onClose: () => void;
  /** Section id to open the dialog on. Defaults to AI Bot Configuration. */
  defaultSectionId?: string;
}

export const HelpFaqDialog: React.FC<HelpFaqDialogProps> = ({
  isOpen,
  onClose,
  defaultSectionId = 'ai-bot',
}) => {
  const [activeSectionId, setActiveSectionId] = useState<string>(defaultSectionId);
  const [query, setQuery] = useState('');

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="HandsOff — Frequently Asked Questions"
      size="xl"
    >
      <FaqContent
        className="-m-6 min-h-[60vh] max-h-[70vh]"
        activeSectionId={activeSectionId}
        onSectionChange={setActiveSectionId}
        query={query}
        onQueryChange={setQuery}
        autoFocusSearch
      />
    </Modal>
  );
};

export default HelpFaqDialog;
