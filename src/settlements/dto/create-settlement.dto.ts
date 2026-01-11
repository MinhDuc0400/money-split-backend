import { IsString, IsNumber, IsUUID, Min, IsOptional } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class CreateSettlementDto {
  @ApiProperty({ example: 'uuid-of-member-paying' })
  @IsUUID()
  fromId: string;

  @ApiProperty({ example: 'uuid-of-member-receiving' })
  @IsUUID()
  toId: string;

  @ApiProperty({ example: 50.0 })
  @IsNumber()
  @Min(0.01)
  amount: number;

  @ApiProperty({ example: 'USD', required: false })
  @IsString()
  @IsOptional()
  currency?: string;

  @ApiProperty({ example: 'Dinner repayment', required: false })
  @IsString()
  @IsOptional()
  note?: string;
}
