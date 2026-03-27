import React, { useState } from 'react';
import { BookOpen, FileText, Settings2, BarChart3 } from 'lucide-react';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { useAppAuth } from '@/auth/useAppAuth';
import DocumentsTab from './knowledge/DocumentsTab';
import AiSettingsTab from './knowledge/AiSettingsTab';
import OverviewTab from './knowledge/OverviewTab';

const KnowledgeBase: React.FC = () => {
  const { isRole } = useAppAuth();
  const [activeTab, setActiveTab] = useState('documents');
  const [docFilter, setDocFilter] = useState<string | undefined>();

  const handleNavigateToDocuments = (filter?: string) => {
    setDocFilter(filter);
    setActiveTab('documents');
  };

  const handleTabChange = (tab: string) => {
    if (tab !== 'documents') setDocFilter(undefined);
    setActiveTab(tab);
  };

  return (
    <div className="h-full overflow-y-auto">
      {/* Page Header */}
      <div className="px-6 pt-6 pb-4">
        <div className="flex items-center gap-3 mb-1">
          <div className="p-2 rounded-xl bg-primary-500/10">
            <BookOpen className="w-5 h-5 text-primary-400" />
          </div>
          <div>
            <h1 className="text-lg font-semibold text-text-primary">Knowledge Base</h1>
            <p className="text-xs text-text-muted">
              Manage documents, configure your AI bot, and monitor performance
            </p>
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div className="px-6">
        <Tabs value={activeTab} onValueChange={handleTabChange} className="w-full">
          <TabsList className="w-full sm:w-auto">
            <TabsTrigger value="documents" className="gap-1.5">
              <FileText className="w-3.5 h-3.5" />
              Documents
            </TabsTrigger>
            {isRole(['admin', 'supervisor']) && (
              <TabsTrigger value="ai-settings" className="gap-1.5">
                <Settings2 className="w-3.5 h-3.5" />
                AI Settings
              </TabsTrigger>
            )}
            <TabsTrigger value="overview" className="gap-1.5">
              <BarChart3 className="w-3.5 h-3.5" />
              Overview
            </TabsTrigger>
          </TabsList>

          <TabsContent value="documents">
            <DocumentsTab initialFilter={docFilter} />
          </TabsContent>

          {isRole(['admin', 'supervisor']) && (
            <TabsContent value="ai-settings">
              <AiSettingsTab />
            </TabsContent>
          )}

          <TabsContent value="overview">
            <OverviewTab onNavigateToDocuments={handleNavigateToDocuments} />
          </TabsContent>
        </Tabs>
      </div>

      {/* Bottom padding for scroll */}
      <div className="h-6" />
    </div>
  );
};

export default KnowledgeBase;
