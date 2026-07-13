import { IsString, IsUUID, IsNumber, Min } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class SettleGuestDto {
  @ApiProperty({ example: 'uuid-of-guest-member' })
  @IsUUID()
  guestMemberId: string;

  @ApiProperty({ example: 'USD' })
  @IsString()
  currency: string;

  @ApiProperty({ example: 50.0 })
  @IsNumber()
  @Min(0.01)
  amount: number;
}
