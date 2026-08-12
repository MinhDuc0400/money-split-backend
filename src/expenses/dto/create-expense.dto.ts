import {
  IsString,
  IsNumber,
  IsEnum,
  IsArray,
  ValidateNested,
  IsOptional,
  IsNotEmpty,
  IsUUID,
  Min,
  ArrayMinSize,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';
import { SplitType, ExpenseCategory } from '@prisma/client';

class PayerDto {
  @ApiProperty({ example: 'uuid-of-member' })
  @IsUUID()
  memberId: string;

  @ApiProperty({ example: 50.0 })
  @IsNumber()
  @Min(0)
  amount: number;
}

class SplitDto {
  @ApiProperty({ example: 'uuid-of-member' })
  @IsUUID()
  memberId: string;

  @ApiProperty({ example: 25.0, required: false })
  @IsOptional()
  @IsNumber()
  @Min(0)
  amount?: number;

  @ApiProperty({ example: 1, required: false })
  @IsOptional()
  @IsNumber()
  @Min(0)
  share?: number;

  @ApiProperty({ example: 50.0, required: false })
  @IsOptional()
  @IsNumber()
  @Min(0)
  percentage?: number;
}

export class CreateExpenseDto {
  @ApiProperty({ example: 'Lunch' })
  @IsString()
  @IsNotEmpty()
  description: string;

  @ApiProperty({ example: 100.0 })
  @IsNumber()
  @Min(0.01)
  amount: number;

  @ApiProperty({ enum: SplitType, example: SplitType.EVEN })
  @IsEnum(SplitType)
  splitType: SplitType;

  @ApiProperty({ example: 'USD' })
  @IsString()
  @IsOptional()
  currency?: string;

  @ApiProperty({
    enum: ExpenseCategory,
    example: ExpenseCategory.OTHER,
    required: false,
  })
  @IsOptional()
  @IsEnum(ExpenseCategory)
  category?: ExpenseCategory;

  @ApiProperty({ type: [PayerDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => PayerDto)
  payers: PayerDto[];

  @ApiProperty({ type: [SplitDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => SplitDto)
  splits: SplitDto[];

  @ApiProperty({ example: '2026-01-09T22:32:00.000Z', required: false })
  @IsOptional()
  @Type(() => Date)
  date?: Date;
}
