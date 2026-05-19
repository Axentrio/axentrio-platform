// portal/src/components/settings/CalcomSettings.tsx
import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Calendar, CheckCircle, Loader2, ChevronDown, Eye, EyeOff } from 'lucide-react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  useIntegrations,
  useConnectCalcom,
  useFetchCalcomEventTypes,
  useUpdateIntegrations,
} from '../../queries/useIntegrationQueries';

type State = 'idle' | 'connecting' | 'needs_event_type' | 'pick_event_type' | 'saving' | 'connected' | 'disconnecting';

interface EventType {
  id: number;
  title: string;
  length: number;
  slug: string;
}

export const CalcomSettings: React.FC = () => {
  const { t } = useTranslation();
  const { data: integrations, isLoading } = useIntegrations();
  const connectMutation = useConnectCalcom();
  const fetchEventTypesMutation = useFetchCalcomEventTypes();
  const updateMutation = useUpdateIntegrations();

  const [state, setState] = useState<State>('idle');
  const [apiKey, setApiKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [eventTypes, setEventTypes] = useState<EventType[]>([]);
  const [selectedEventType, setSelectedEventType] = useState<number | null>(null);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [showDisconnectConfirm, setShowDisconnectConfirm] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [language, setLanguage] = useState('en');
  const [collectFields, setCollectFields] = useState<string[]>(['name', 'email']);

  // Derive state from server data on load
  useEffect(() => {
    if (!integrations) return;
    const calcom = integrations.calcom;
    if (calcom?.hasApiKey && calcom?.eventTypeId) {
      setState('connected');
      setSelectedEventType(calcom.eventTypeId);
      setLanguage(calcom.language || 'en');
      setCollectFields(calcom.collectFields || ['name', 'email']);
    } else if (calcom?.hasApiKey && !calcom?.eventTypeId) {
      // Key stored but no event type selected yet — show partial connected state
      setState('needs_event_type');
    } else {
      setState('idle');
    }
  }, [integrations]);

  const handleConnect = async () => {
    setConnectError(null);
    setState('connecting');
    try {
      const result = await connectMutation.mutateAsync(apiKey);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const types = (result as any)?.eventTypes || (result as any)?.data?.eventTypes || [];
      setEventTypes(types);
      if (types.length === 1) {
        setSelectedEventType(types[0].id);
      }
      setState('pick_event_type');
      setApiKey('');
    } catch (err: unknown) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const anyErr = err as any;
      const msg = anyErr?.response?.data?.error || anyErr?.message || t('settings.integrations.calcom.connectFailed');
      setConnectError(msg);
      setState('idle');
    }
  };

  const handleSaveEventType = async () => {
    if (!selectedEventType) return;
    setState('saving');
    try {
      // Always send full payload to avoid partial-update defaults overwriting existing values
      await updateMutation.mutateAsync({
        calcom: {
          eventTypeId: selectedEventType,
          language,
          collectFields,
        },
      });
      setState('connected');
    } catch {
      setState('pick_event_type');
    }
  };

  const handleDisconnect = async () => {
    setState('disconnecting');
    try {
      await updateMutation.mutateAsync({ calcom: null });
      setState('idle');
      setEventTypes([]);
      setSelectedEventType(null);
      setShowDisconnectConfirm(false);
    } catch {
      setState('connected');
      setShowDisconnectConfirm(false);
    }
  };

  const toggleCollectField = (field: string) => {
    setCollectFields((prev) =>
      prev.includes(field) ? prev.filter((f) => f !== field) : [...prev, field]
    );
  };

  if (isLoading) {
    return (
      <div className="rounded-xl border border-edge bg-surface-3 p-6">
        <div className="flex items-center gap-2 text-text-muted">
          <Loader2 className="h-4 w-4 animate-spin" />
          {t('common.loading')}
        </div>
      </div>
    );
  }

  const selectedType = eventTypes.find((et) => et.id === selectedEventType);

  return (
    <div className="rounded-xl border border-edge bg-surface-3 p-6 space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary-600/10">
            <Calendar className="h-5 w-5 text-primary-400" />
          </div>
          <div>
            <h3 className="text-sm font-semibold text-primary">{t('settings.integrations.calcom.title')}</h3>
            <p className="text-xs text-text-muted">{t('settings.integrations.calcom.subtitle')}</p>
          </div>
        </div>
        {state === 'connected' && (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-green-500/10 px-2.5 py-1 text-xs font-medium text-green-500">
            <CheckCircle className="h-3 w-3" />
            {t('settings.integrations.calcom.connectedBadge')}
          </span>
        )}
      </div>

      {/* Idle: API Key Input */}
      {state === 'idle' && (
        <div className="space-y-3">
          <div>
            <label className="text-xs font-medium text-secondary mb-1 block">{t('settings.integrations.calcom.apiKeyLabel')}</label>
            <div className="flex gap-2">
              <div className="relative flex-1">
                <input
                  type={showKey ? 'text' : 'password'}
                  autoComplete="off"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder="cal_live_..."
                  className="w-full rounded-lg border border-edge bg-transparent px-3 py-2 text-sm text-primary placeholder:text-text-muted focus:border-primary-500 focus:outline-none pr-10"
                />
                <button
                  type="button"
                  onClick={() => setShowKey(!showKey)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-text-muted hover:text-secondary"
                >
                  {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
              <button
                onClick={handleConnect}
                disabled={!apiKey.trim()}
                className="rounded-lg bg-primary-500 px-4 py-2 text-sm font-medium text-white hover:bg-primary-600 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {t('settings.integrations.calcom.connect')}
              </button>
            </div>
            <p className="text-xs text-text-muted mt-1">
              {t('settings.integrations.calcom.apiKeyHelper')}
            </p>
          </div>
          {connectError && (
            <div className="rounded-lg bg-red-500/10 border border-red-500/20 px-3 py-2 text-sm text-red-400">
              {connectError}
            </div>
          )}
        </div>
      )}

      {/* Connecting spinner */}
      {state === 'connecting' && (
        <div className="flex items-center gap-2 text-text-muted py-4">
          <Loader2 className="h-4 w-4 animate-spin" />
          {t('settings.integrations.calcom.connecting')}
        </div>
      )}

      {/* Needs Event Type — key stored but no event type selected */}
      {state === 'needs_event_type' && (
        <div className="space-y-3">
          <p className="text-sm text-text-muted">{t('settings.integrations.calcom.needsEventType.message')}</p>
          <button
            onClick={async () => {
              setConnectError(null);
              try {
                const result = await fetchEventTypesMutation.mutateAsync();
                const types = (result as any)?.eventTypes || (result as any)?.data?.eventTypes || [];
                setEventTypes(types);
                if (types.length === 1) setSelectedEventType(types[0].id);
                setState('pick_event_type');
              } catch {
                setState('needs_event_type');
              }
            }}
            disabled={fetchEventTypesMutation.isPending}
            className="rounded-lg bg-primary-500 px-4 py-2 text-sm font-medium text-white hover:bg-primary-600 disabled:opacity-50"
          >
            {fetchEventTypesMutation.isPending ? (
              <span className="flex items-center gap-2"><Loader2 className="h-3 w-3 animate-spin" /> {t('common.loading')}</span>
            ) : (
              t('settings.integrations.calcom.needsEventType.completeSetup')
            )}
          </button>
        </div>
      )}

      {/* Pick Event Type */}
      {state === 'pick_event_type' && (
        <div className="space-y-3">
          <div>
            <label className="text-xs font-medium text-secondary mb-1 block">{t('settings.integrations.calcom.eventType.label')}</label>
            <p className="text-xs text-text-muted mb-2">{t('settings.integrations.calcom.eventType.helper')}</p>
            <div>
              <Select
                value={selectedEventType?.toString() || ''}
                onValueChange={(val) => setSelectedEventType(Number(val))}
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder={t('settings.integrations.calcom.eventType.placeholder')} />
                </SelectTrigger>
                <SelectContent>
                  {eventTypes.map((et) => (
                    <SelectItem key={et.id} value={et.id.toString()}>
                      {et.title} ({t('settings.integrations.calcom.eventType.minutes', { count: et.length })})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <button
            onClick={handleSaveEventType}
            disabled={!selectedEventType}
            className="rounded-lg bg-primary-500 px-4 py-2 text-sm font-medium text-white hover:bg-primary-600 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {t('common.save')}
          </button>
        </div>
      )}

      {/* Saving spinner */}
      {state === 'saving' && (
        <div className="flex items-center gap-2 text-text-muted py-4">
          <Loader2 className="h-4 w-4 animate-spin" />
          {t('common.saving')}
        </div>
      )}

      {/* Connected */}
      {state === 'connected' && (
        <div className="space-y-4">
          <div className="flex items-center justify-between rounded-lg border border-edge px-3 py-2">
            <div>
              <p className="text-sm text-primary">
                {selectedType?.title || t('settings.integrations.calcom.connected.eventTypeFallback', { id: selectedEventType })}
                {selectedType && <span className="text-text-muted ml-1">({t('settings.integrations.calcom.eventType.minutes', { count: selectedType.length })})</span>}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => {
                  // Re-connect to fetch fresh event types for switching
                  setState('idle');
                  setApiKey('');
                  setEventTypes([]);
                }}
                className="text-xs text-primary-400 hover:text-primary-300"
              >
                {t('settings.integrations.calcom.connected.change')}
              </button>
              <button
                onClick={() => setShowDisconnectConfirm(true)}
                className="text-xs text-red-400 hover:text-red-300"
              >
                {t('settings.integrations.calcom.connected.disconnect')}
              </button>
            </div>
          </div>

          {/* Advanced Settings */}
          <div>
            <button
              onClick={() => setShowAdvanced(!showAdvanced)}
              className="flex items-center gap-1 text-xs text-text-muted hover:text-secondary"
            >
              <ChevronDown className={`h-3 w-3 transition-transform ${showAdvanced ? 'rotate-180' : ''}`} />
              {t('settings.integrations.calcom.advanced.toggle')}
            </button>
            {showAdvanced && (
              <div className="mt-3 space-y-3 pl-4 border-l border-edge">
                <div>
                  <label className="text-xs font-medium text-secondary mb-1 block">{t('settings.integrations.calcom.advanced.language')}</label>
                  <Select value={language} onValueChange={setLanguage}>
                    <SelectTrigger className="w-[180px]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="en">English</SelectItem>
                      <SelectItem value="nl">Nederlands</SelectItem>
                      <SelectItem value="fr">Français</SelectItem>
                      <SelectItem value="de">Deutsch</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <label className="text-xs font-medium text-secondary mb-1 block">{t('settings.integrations.calcom.advanced.collectLabel')}</label>
                  <div className="flex flex-wrap gap-2">
                    {['name', 'email', 'phone', 'notes'].map((field) => (
                      <label key={field} className="flex items-center gap-1.5 text-xs text-secondary">
                        <input
                          type="checkbox"
                          checked={collectFields.includes(field)}
                          onChange={() => toggleCollectField(field)}
                          disabled={field === 'name' || field === 'email'}
                          className="rounded border-edge"
                        />
                        {t(`settings.integrations.calcom.advanced.fields.${field}`)}
                      </label>
                    ))}
                  </div>
                </div>
                <button
                  onClick={handleSaveEventType}
                  className="rounded-lg bg-primary-500 px-3 py-1.5 text-xs font-medium text-white hover:bg-primary-600"
                >
                  {t('settings.integrations.calcom.advanced.save')}
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Disconnect Confirmation */}
      {showDisconnectConfirm && (
        <div className="rounded-lg border border-red-500/20 bg-red-500/5 p-3 space-y-2">
          <p className="text-sm text-primary">{t('settings.integrations.calcom.disconnectConfirm.message')}</p>
          <div className="flex gap-2">
            <button
              onClick={handleDisconnect}
              disabled={state === 'disconnecting'}
              className="rounded-lg bg-red-500 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-600 disabled:opacity-50"
            >
              {state === 'disconnecting' ? t('settings.integrations.calcom.disconnectConfirm.disconnecting') : t('settings.integrations.calcom.disconnectConfirm.confirm')}
            </button>
            <button
              onClick={() => setShowDisconnectConfirm(false)}
              className="rounded-lg border border-edge px-3 py-1.5 text-xs font-medium text-secondary hover:bg-surface-3"
            >
              {t('common.cancel')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
