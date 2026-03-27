import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddAiSettingsToTenant1775200000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE tenants
      SET settings = jsonb_set(
        settings #- '{features,aiEnabled}',
        '{ai}',
        jsonb_build_object(
          'enabled', COALESCE((settings->'features'->>'aiEnabled')::boolean, false),
          'provider', 'openai',
          'model', 'gpt-4o-mini',
          'brandVoice', jsonb_build_object(
            'name', 'AI Assistant',
            'tone', 'friendly',
            'customInstructions', ''
          ),
          'guardrails', jsonb_build_object(
            'topicsToAvoid', '[]'::jsonb,
            'escalationKeywords', '[]'::jsonb,
            'confidenceThreshold', 0.7,
            'maxResponseLength', 500,
            'greetingMessage', 'Hello! How can I help you today?',
            'fallbackMessage', 'I''m not sure about that. Let me connect you with a human agent.',
            'offHoursMessage', 'We''re currently outside business hours. We''ll get back to you soon.'
          )
        )
      )
      WHERE settings->'features'->'aiEnabled' IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE tenants
      SET settings = jsonb_set(
        settings #- '{ai}',
        '{features,aiEnabled}',
        COALESCE(settings->'ai'->'enabled', 'false'::jsonb)
      )
      WHERE settings->'ai' IS NOT NULL
    `);
  }
}
