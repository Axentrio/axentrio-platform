import React, { useState, KeyboardEvent } from 'react';
import { X } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';

interface TagInputProps {
  value: string[];
  onChange: (tags: string[]) => void;
  placeholder?: string;
  disabled?: boolean;
}

const TagInput: React.FC<TagInputProps> = ({ value, onChange, placeholder, disabled }) => {
  const [input, setInput] = useState('');

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && input.trim()) {
      e.preventDefault();
      const tag = input.trim();
      if (!value.includes(tag)) {
        onChange([...value, tag]);
      }
      setInput('');
    }
    if (e.key === 'Backspace' && !input && value.length > 0) {
      onChange(value.slice(0, -1));
    }
  };

  const removeTag = (tag: string) => {
    onChange(value.filter((t) => t !== tag));
  };

  return (
    <div className="flex flex-wrap gap-1.5 p-2 border border-edge rounded-lg bg-surface-0 min-h-[42px]">
      {value.map((tag) => (
        <Badge key={tag} variant="secondary" className="gap-1 pr-1">
          {tag}
          {!disabled && (
            <button
              type="button"
              onClick={() => removeTag(tag)}
              className="hover:text-text-primary"
            >
              <X className="w-3 h-3" />
            </button>
          )}
        </Badge>
      ))}
      {!disabled && (
        <Input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={value.length === 0 ? placeholder : ''}
          className="border-0 shadow-none focus-visible:ring-0 p-0 h-6 min-w-[100px] flex-1"
          disabled={disabled}
        />
      )}
    </div>
  );
};

export default TagInput;
