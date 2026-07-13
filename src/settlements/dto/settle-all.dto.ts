import {
  IsString,
  IsUUID,
  IsArray,
  ArrayMinSize,
  ValidateNested,
  IsNumber,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';

class SettleAllItemDto {
  @ApiProperty({ example: 'USD' })
  @IsString()
  currency: string;

  @ApiProperty({ example: 30.0 })
  @IsNumber()
  @Min(0.01)
  amount: number;
}

export class SettleAllDto {
  @ApiProperty({ example: 'uuid-of-member-paying' })
  @IsUUID()
  fromId: string;

  @ApiProperty({ example: 'uuid-of-member-receiving' })
  @IsUUID()
  toId: string;

  @ApiProperty({
    type: [SettleAllItemDto],
    description:
      'Exact (currency, amount) pairs the client displayed and wants to settle in one batch. The server validates each against current balances before executing.',
  })
  @IsArray()
  @ArrayMinSize(1, { message: 'At least one item is required' })
  @ValidateNested({ each: true })
  @Type(() => SettleAllItemDto)
  items: SettleAllItemDto[];
}
