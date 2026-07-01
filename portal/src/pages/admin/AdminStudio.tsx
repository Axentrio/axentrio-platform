/**
 * Bot Studio — one super-admin surface for the whole composition: Templates
 * (composed products) · Modules (authored building blocks) · Skills (engineered
 * atoms). Replaces the separate Bot Templates + Modules nav entries. The list of
 * each layer lives here as a tab; the focused editors stay on their own routes.
 *
 * When composable templates is off, this is just the Templates library.
 */
import React from 'react';
import { useSearchParams } from 'react-router-dom';
import { FileText, Boxes, Cpu } from 'lucide-react';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import AdminBotTemplates from './AdminBotTemplates';
import AdminModules from './AdminModules';
import { SkillsReference } from '@/components/admin/SkillsReference';
import { COMPOSABLE_TEMPLATES_ENABLED } from '@/config/featureFlags';

const AdminStudio: React.FC = () => {
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') ?? 'templates';
  const setTab = (v: string) => setParams({ tab: v }, { replace: true });

  if (!COMPOSABLE_TEMPLATES_ENABLED) return <AdminBotTemplates />;

  return (
    <div className="h-full overflow-y-auto p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-text-primary">Bot Studio</h1>
        {/* The one caption that names the composition, so the tabs read as layers. */}
        <p className="text-sm text-text-secondary">
          Templates compose modules&nbsp;·&nbsp;modules bind skills. Build a bot from reusable pieces.
        </p>
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="templates" className="gap-1.5"><FileText className="h-4 w-4" />Templates</TabsTrigger>
          <TabsTrigger value="modules" className="gap-1.5"><Boxes className="h-4 w-4" />Modules</TabsTrigger>
          <TabsTrigger value="skills" className="gap-1.5"><Cpu className="h-4 w-4" />Skills</TabsTrigger>
        </TabsList>
        <TabsContent value="templates" className="mt-6"><AdminBotTemplates embedded /></TabsContent>
        <TabsContent value="modules" className="mt-6"><AdminModules embedded /></TabsContent>
        <TabsContent value="skills" className="mt-6"><SkillsReference /></TabsContent>
      </Tabs>
    </div>
  );
};

export default AdminStudio;
