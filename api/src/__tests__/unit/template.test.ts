import { describe, it, expect } from 'vitest';
import { renderTemplate, getAvailableVariables, buildVariablesFromEvent } from '../../automations/template';

describe('renderTemplate', () => {
  it('replaces a simple variable', () => {
    const result = renderTemplate('Hello, {name}!', { name: 'Alice' });
    expect(result).toBe('Hello, Alice!');
  });

  it('replaces multiple variables', () => {
    const result = renderTemplate('{greeting}, {name}!', { greeting: 'Hi', name: 'Bob' });
    expect(result).toBe('Hi, Bob!');
  });

  it('leaves unmatched variables as-is', () => {
    const result = renderTemplate('Hello, {name}! Your code is {code}.', { name: 'Alice' });
    expect(result).toBe('Hello, Alice! Your code is {code}.');
  });

  it('returns template unchanged for empty variables object', () => {
    const result = renderTemplate('Hello, {name}!', {});
    expect(result).toBe('Hello, {name}!');
  });

  it('returns empty string for empty template', () => {
    const result = renderTemplate('', { name: 'Alice' });
    expect(result).toBe('');
  });

  it('escapes HTML in variable values to prevent XSS', () => {
    const result = renderTemplate('{content}', { content: '<script>alert("xss")</script>' });
    expect(result).toBe('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;');
  });

  it('escapes ampersands in variable values', () => {
    const result = renderTemplate('{value}', { value: 'cats & dogs' });
    expect(result).toBe('cats &amp; dogs');
  });

  it('escapes single quotes in variable values', () => {
    const result = renderTemplate('{value}', { value: "it's fine" });
    expect(result).toBe('it&#39;s fine');
  });

  it('handles template with no placeholders', () => {
    const result = renderTemplate('No placeholders here.', { name: 'Alice' });
    expect(result).toBe('No placeholders here.');
  });
});

describe('getAvailableVariables', () => {
  it('returns correct variables for appointment.booked', () => {
    const vars = getAvailableVariables('appointment.booked');
    expect(vars).toContain('name');
    expect(vars).toContain('email');
    expect(vars).toContain('date');
    expect(vars).toContain('time');
  });

  it('returns correct variables for lead.created', () => {
    const vars = getAvailableVariables('lead.created');
    expect(vars).toContain('name');
    expect(vars).toContain('email');
    expect(vars).toContain('phone');
    expect(vars).toContain('notes'); // the captured request — usable in the new-lead email
  });

  it('returns correct variables for conversation.ended', () => {
    const vars = getAvailableVariables('conversation.ended');
    expect(vars).toContain('messageCount');
    expect(vars).toContain('duration');
    expect(vars).toContain('tags');
  });

  it('returns empty array for unknown event type', () => {
    const vars = getAvailableVariables('unknown.event');
    expect(vars).toEqual([]);
  });
});

describe('buildVariablesFromEvent', () => {
  it('builds variables for appointment.booked', () => {
    const event = {
      type: 'appointment.booked',
      data: { name: 'Alice', email: 'alice@example.com', date: '2026-04-10', time: '14:00' },
    };
    const vars = buildVariablesFromEvent(event, 'Acme Corp', 'SupportBot');
    expect(vars.name).toBe('Alice');
    expect(vars.email).toBe('alice@example.com');
    expect(vars.date).toBe('2026-04-10');
    expect(vars.time).toBe('14:00');
    expect(vars.tenantName).toBe('Acme Corp');
    expect(vars.botName).toBe('SupportBot');
  });

  it('builds variables for lead.created', () => {
    const event = {
      type: 'lead.created',
      data: { name: 'Bob', email: 'bob@example.com', phone: '+1-555-0100', notes: 'Leak under the kitchen sink' },
    };
    const vars = buildVariablesFromEvent(event, 'Acme Corp', 'SupportBot');
    expect(vars.name).toBe('Bob');
    expect(vars.email).toBe('bob@example.com');
    expect(vars.phone).toBe('+1-555-0100');
    expect(vars.notes).toBe('Leak under the kitchen sink');
    expect(vars.tenantName).toBe('Acme Corp');
    expect(vars.botName).toBe('SupportBot');
  });

  it('builds variables for conversation.ended', () => {
    const event = {
      type: 'conversation.ended',
      data: { messageCount: 12, duration: 300, tags: ['billing', 'resolved'] },
    };
    const vars = buildVariablesFromEvent(event, 'Acme Corp', 'SupportBot');
    expect(vars.messageCount).toBe('12');
    expect(vars.duration).toBe('300');
    expect(vars.tags).toBe('billing, resolved');
    expect(vars.tenantName).toBe('Acme Corp');
    expect(vars.botName).toBe('SupportBot');
  });

  it('returns base variables for unknown event type', () => {
    const event = { type: 'unknown.event', data: {} };
    const vars = buildVariablesFromEvent(event, 'Acme Corp', 'SupportBot');
    expect(vars.tenantName).toBe('Acme Corp');
    expect(vars.botName).toBe('SupportBot');
    expect(Object.keys(vars)).toHaveLength(2);
  });

  it('handles missing data fields gracefully', () => {
    const event = { type: 'appointment.booked', data: {} };
    const vars = buildVariablesFromEvent(event, 'T', 'B');
    expect(vars.name).toBe('');
    expect(vars.email).toBe('');
    expect(vars.date).toBe('');
    expect(vars.time).toBe('');
  });

  it('handles missing data object gracefully', () => {
    const event = { type: 'lead.created' };
    const vars = buildVariablesFromEvent(event, 'T', 'B');
    expect(vars.name).toBe('');
    expect(vars.email).toBe('');
    expect(vars.phone).toBe('');
  });
});
