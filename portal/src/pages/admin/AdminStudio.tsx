/**
 * Bot Studio — the super-admin surface for the composition: Templates (composed
 * products) · Skills (the engineered building blocks a template binds). A module
 * IS a skill (1:1), so there is one Skills tab, read-only — prose is frozen in
 * code, not authored here. The focused template editor stays on its own route.
 *
 * When composable templates is off, this is just the Templates library.
 */
import React from 'react';
import { useSearchParams } from 'react-router-dom';
import { FileText, Cpu } from 'lucide-react';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import AdminBotTemplates from './AdminBotTemplates';
import { SkillsReference } from '@/components/admin/SkillsReference';
import { COMPOSABLE_TEMPLATES_ENABLED } from '@/config/featureFlags';

const AdminStudio: React.FC = () => {
  const [params, setParams] = useSearchParams();
  // 'modules' is the legacy alias for 'skills' (module==skill).
  const raw = params.get('tab');
  const tab = raw === 'modules' ? 'skills' : (raw ?? 'templates');
  const setTab = (v: string) => setParams({ tab: v }, { replace: true });

  if (!COMPOSABLE_TEMPLATES_ENABLED) return <AdminBotTemplates />;

  return (
    <div className="h-full overflow-y-auto p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-text-primary">Bot Studio</h1>
        <p className="text-sm text-text-secondary">
          Templates bind skills. Build a bot from reusable pieces.
        </p>
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="templates" className="gap-1.5"><FileText className="h-4 w-4" />Templates</TabsTrigger>
          <TabsTrigger value="skills" className="gap-1.5"><Cpu className="h-4 w-4" />Skills</TabsTrigger>
        </TabsList>
        <TabsContent value="templates" className="mt-6"><AdminBotTemplates embedded /></TabsContent>
        <TabsContent value="skills" className="mt-6"><SkillsReference /></TabsContent>
      </Tabs>
    </div>
  );
};

export default AdminStudio;
