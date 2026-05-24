import {
  Entity,
  PrimaryColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

export interface FaqTranslation {
  en: string;
  nl?: string;
  fr?: string;
}

@Entity('faq_sections')
@Index(['position'])
export class FaqSection {
  @PrimaryColumn({ type: 'varchar', length: 64 })
  id!: string;

  @Column({ type: 'int' })
  position!: number;

  @Column({ type: 'boolean', default: false })
  isReserved!: boolean;

  @Column({ type: 'jsonb' })
  titles!: FaqTranslation;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
