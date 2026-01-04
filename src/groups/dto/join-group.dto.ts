import { IsString, IsNotEmpty, Length } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class JoinGroupDto {
  @ApiProperty({
    example: 'A1B2C3D4',
    description: 'The unique invite code of the group',
    minLength: 8,
    maxLength: 8,
  })
  @IsString()
  @IsNotEmpty()
  @Length(8, 8)
  inviteCode: string;
}
