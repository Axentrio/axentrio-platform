/**
 * TypingIndicator Component
 * Shows when user is typing with animated dots
 */

import React from 'react';

interface TypingIndicatorProps {
  users?: string[];
  showNames?: boolean;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}

export const TypingIndicator: React.FC<TypingIndicatorProps> = ({
  users = [],
  showNames = true,
  size = 'md',
  className = '',
}) => {
  const getSizeClass = () => {
    switch (size) {
      case 'sm':
        return 'w-1 h-1';
      case 'md':
        return 'w-1.5 h-1.5';
      case 'lg':
        return 'w-2 h-2';
      default:
        return 'w-1.5 h-1.5';
    }
  };

  const dotSize = getSizeClass();

  const getTypingText = () => {
    if (users.length === 0) return 'Someone is typing';
    if (users.length === 1) return `${users[0]} is typing`;
    if (users.length === 2) return `${users[0]} and ${users[1]} are typing`;
    return `${users.length} people are typing`;
  };

  return (
    <div className={`flex items-center gap-2 ${className}`}>
      {/* Animated dots */}
      <div className="flex items-center gap-1">
        <span
          className={`${dotSize} bg-text-muted rounded-full animate-bounce`}
          style={{ animationDelay: '0ms' }}
        />
        <span
          className={`${dotSize} bg-text-muted rounded-full animate-bounce`}
          style={{ animationDelay: '150ms' }}
        />
        <span
          className={`${dotSize} bg-text-muted rounded-full animate-bounce`}
          style={{ animationDelay: '300ms' }}
        />
      </div>

      {/* Typing text */}
      {showNames && (
        <span className="text-sm text-text-muted italic">
          {getTypingText()}
        </span>
      )}
    </div>
  );
};

// Compact version for chat bubbles
export const CompactTypingIndicator: React.FC<{ className?: string }> = ({ className = '' }) => (
  <div className={`flex items-center gap-1 px-3 py-2 bg-surface-3 rounded-2xl ${className}`}>
    <span className="w-1.5 h-1.5 bg-text-muted rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
    <span className="w-1.5 h-1.5 bg-text-muted rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
    <span className="w-1.5 h-1.5 bg-text-muted rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
  </div>
);

