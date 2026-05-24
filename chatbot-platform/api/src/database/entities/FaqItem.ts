import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
  Unique,
} from 'typeorm';
import { FaqSection, FaqTranslation } from './FaqSection';

@Entity('faq_items')
@Index(['sectionId', 'position'])
@Unique(['sectionId', 'slug'])
export class FaqItem {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 64 })
  sectionId!: string;

  @Column({ type: 'varchar', length: 80 })
  slug!: string;

  @Column({ type: 'int' })
  position!: number;

  @Column({ type: 'jsonb' })
  question!: FaqTranslation;

  @Column({ type: 'jsonb' })
  answer!: FaqTranslation;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;

  @ManyToOne(() => FaqSection, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'sectionId' })
  section!: FaqSection;
}
