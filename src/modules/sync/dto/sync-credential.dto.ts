import { IsString, IsNotEmpty, MaxLength } from 'class-validator';

export class CreateSyncCredentialDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  source!: string;
}
