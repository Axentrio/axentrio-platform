/**
 * Profile Settings
 * User profile information and password management
 */

import React, { useState } from 'react';
import { User, Lock, Mail, Save, Check, Loader2 } from 'lucide-react';
import { useAppAuth, useUser } from '@auth/useAppAuth';
import { api } from '@services/apiClient';
import { Card, CardHeader, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

const ProfileSettings: React.FC = () => {
  const { user } = useAppAuth();
  const { user: clerkUser } = useUser();

  const [isSaving, setIsSaving] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);

  const [profileData, setProfileData] = useState({
    firstName: user?.firstName || '',
    lastName: user?.lastName || '',
    email: user?.email || '',
  });

  const handleSaveProfile = async () => {
    if (!clerkUser) return;
    setIsSaving(true);
    try {
      await clerkUser.update({
        firstName: profileData.firstName,
        lastName: profileData.lastName,
      });
      const fullName = [profileData.firstName, profileData.lastName].filter(Boolean).join(' ');
      await api.patch('/users/profile', { name: fullName });
      setSaveSuccess(true);
      setTimeout(() => setSaveSuccess(false), 3000);
    } catch {
      // Clerk or backend update failed
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      {saveSuccess && (
        <div className="p-4 bg-status-online/10 border border-status-online/20 rounded-xl flex items-center gap-2 text-status-online">
          <Check className="w-5 h-5" />
          Settings saved successfully!
        </div>
      )}

      <Card variant="glass">
        <CardHeader>
          <h2 className="text-lg font-semibold text-text-primary flex items-center gap-2">
            <User className="w-5 h-5" />
            Profile Information
          </h2>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1">
                <Label htmlFor="firstName" className="text-text-secondary">First Name</Label>
                <Input
                  id="firstName"
                  type="text"
                  value={profileData.firstName}
                  onChange={(e) => setProfileData({ ...profileData, firstName: e.target.value })}
                  disabled={isSaving}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="lastName" className="text-text-secondary">Last Name</Label>
                <Input
                  id="lastName"
                  type="text"
                  value={profileData.lastName}
                  onChange={(e) => setProfileData({ ...profileData, lastName: e.target.value })}
                  disabled={isSaving}
                />
              </div>
            </div>
            <div className="space-y-1">
              <Label htmlFor="email" className="text-text-secondary">Email</Label>
              <div className="flex items-center gap-2">
                <Mail className="w-5 h-5 text-text-muted" />
                <Input
                  id="email"
                  type="email"
                  value={profileData.email}
                  disabled
                  className="flex-1"
                />
              </div>
              <p className="text-xs text-text-muted">Email cannot be changed</p>
            </div>
            <div className="flex justify-end">
              <Button onClick={handleSaveProfile} disabled={isSaving}>
                {isSaving ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Save className="w-4 h-4" />
                )}
                Save Changes
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card variant="glass">
        <CardHeader>
          <h2 className="text-lg font-semibold text-text-primary flex items-center gap-2">
            <Lock className="w-5 h-5" />
            Password
          </h2>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-text-secondary">
            Your password is managed by Clerk. To change your password, use the Clerk user menu or visit your Clerk account settings.
          </p>
        </CardContent>
      </Card>
    </div>
  );
};

export default ProfileSettings;
