import { PartialType } from '@nestjs/mapped-types';
import { CreateNoDeducibleDto } from './create-no-deducible.dto';

export class UpdateNoDeducibleDto extends PartialType(CreateNoDeducibleDto) {}
