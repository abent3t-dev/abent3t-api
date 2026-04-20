import { PartialType } from '@nestjs/mapped-types';
import { CreatePerdidaFiscalDto } from './create-perdida-fiscal.dto';

export class UpdatePerdidaFiscalDto extends PartialType(CreatePerdidaFiscalDto) {}
