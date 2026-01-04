import { IsString, IsNotEmpty, IsOptional } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class CreateGroupDto {
  @ApiProperty({
    example: 'Trip to Japan',
    description: 'The name of the group',
  })
  @IsString()
  @IsNotEmpty()
  name: string;

  @ApiProperty({
    example: 'JPY',
    description: 'The default currency for the group',
    required: false,
    default: 'USD',
  })
  @IsString()
  @IsOptional()
  currency?: string;
}
