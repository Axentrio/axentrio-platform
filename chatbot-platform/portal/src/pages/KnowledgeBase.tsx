import React, { useState } from 'react';
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

  // Clear filter when manually switching tabs
  const handleTabChange = (tab: string) => {
    if (tab !== 'documents') setDocFilter(undefined);
    setActiveTab(tab);
  };

  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="flex justify-between items-center mb-4">
        <div>
          <h1 className="text-xl font-semibold text-text-primary">Knowledge Base</h1>
          <p className="text-sm text-text-secondary mt-1">
            Manage your AI bot's knowledge and configuration
          </p>
        </div>
      </div>

      <Tabs value={activeTab} onValueChange={handleTabChange} className="w-full">
        <TabsList>
          <TabsTrigger value="documents">Documents</TabsTrigger>
          {isRole(['admin', 'supervisor']) && (
            <TabsTrigger value="ai-settings">AI Settings</TabsTrigger>
          )}
          <TabsTrigger value="overview">Overview</TabsTrigger>
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
  );
};

export default KnowledgeBase;
