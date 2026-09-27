import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  IsEmail,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsIn,
} from "class-validator";

export class LoginDto {
  @ApiProperty({ example: "marius@riles.app" })
  @IsEmail()
  email: string;

  @ApiPropertyOptional({ example: "password123" })
  @IsOptional()
  @IsString()
  password?: string;
}

export class SocialAuthDto {
  @ApiProperty({ example: "apple", enum: ["apple", "google", "email"] })
  @IsIn(["apple", "google", "email"])
  provider: "apple" | "google" | "email";

  @ApiPropertyOptional({ example: "marius@riles.app" })
  @IsOptional()
  @IsEmail()
  email?: string;

  @ApiPropertyOptional({ example: "Marius" })
  @IsOptional()
  @IsString()
  name?: string;

  @ApiPropertyOptional({ example: "oauth_id_token_xyz" })
  @IsOptional()
  @IsString()
  identityToken?: string;
}

export class RegisterDto {
  @ApiProperty({ example: "marius@riles.app" })
  @IsEmail()
  email: string;

  @ApiProperty({ example: "Marius" })
  @IsNotEmpty()
  @IsString()
  name: string;

  @ApiPropertyOptional({ example: "password123" })
  @IsOptional()
  @IsString()
  password?: string;
}

export class AuthResponseDto {
  @ApiProperty({ example: "eyJhbGciOiJIUzI1NiIsIn..." })
  accessToken: string;

  @ApiProperty({ example: "user-01" })
  userId: string;

  @ApiProperty({ example: "marius@riles.app" })
  email: string;

  @ApiProperty({ example: "Marius" })
  name: string;
}
