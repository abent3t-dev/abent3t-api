import { PartialType } from '@nestjs/mapped-types';
import { CreateCommitteeDto } from './create-committee.dto';

/** Fase §16 — Edición de metadata (solo en borrador o rechazado). */
export class UpdateCommitteeDto extends PartialType(CreateCommitteeDto) {}
