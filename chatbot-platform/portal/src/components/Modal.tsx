/**
 * Modal Component
 * Reusable modal dialog — powered by shadcn Dialog (Radix)
 */

import React from 'react';
import { X } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogOverlay,
  DialogPortal,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title?: string;
  children: React.ReactNode;
  size?: 'sm' | 'md' | 'lg' | 'xl' | 'full';
  showCloseButton?: boolean;
  closeOnOverlayClick?: boolean;
}

const sizeClasses: Record<NonNullable<ModalProps['size']>, string> = {
  sm: 'max-w-md',
  md: 'max-w-lg',
  lg: 'max-w-2xl',
  xl: 'max-w-4xl',
  full: 'max-w-full mx-4',
};

export const Modal: React.FC<ModalProps> = ({
  isOpen,
  onClose,
  title,
  children,
  size = 'md',
  showCloseButton = true,
  closeOnOverlayClick = true,
}) => {
  return (
    <Dialog
      open={isOpen}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPortal>
        <DialogOverlay className="bg-black/60 backdrop-blur-sm" />
        <DialogContent
          className={cn(
            sizeClasses[size],
            'bg-surface-2 rounded-2xl shadow-card border border-edge p-0 gap-0',
            // Hide the default shadcn/radix close button — we render our own
            '[&>button.absolute]:hidden',
          )}
          onInteractOutside={(e) => {
            if (!closeOnOverlayClick) e.preventDefault();
          }}
        >
          {/* Visually-hidden title for accessibility when no visible title */}
          {!title && (
            <DialogTitle className="sr-only">Dialog</DialogTitle>
          )}

          {/* Header */}
          {(title || showCloseButton) && (
            <DialogHeader className="flex flex-row items-center justify-between px-6 py-4 border-b border-edge space-y-0">
              {title ? (
                <DialogTitle className="text-lg font-semibold text-text-primary">
                  {title}
                </DialogTitle>
              ) : (
                <div />
              )}
              {showCloseButton && (
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={onClose}
                  className="text-text-muted hover:text-text-secondary hover:bg-surface-3 rounded-xl"
                >
                  <X className="w-5 h-5" />
                </Button>
              )}
            </DialogHeader>
          )}

          {/* Content */}
          <div className="p-6">{children}</div>
        </DialogContent>
      </DialogPortal>
    </Dialog>
  );
};

export default Modal;
