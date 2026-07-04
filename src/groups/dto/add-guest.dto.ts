import { IsString, IsNotEmpty, MaxLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class AddGuestDto {
  @ApiProperty({
    example: 'Sam',
    description: 'Display name for a guest participant who has no account',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  name: string;
}
