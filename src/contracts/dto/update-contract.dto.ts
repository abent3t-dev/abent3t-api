import { PartialType } from '@nestjs/mapped-types';
import { CreateContractDto } from './create-contract.dto';

/** Fase §15 — Edición parcial de metadata del contrato. */
export class UpdateContractDto extends PartialType(CreateContractDto) {}
