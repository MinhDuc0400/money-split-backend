import {
  Controller,
  Post,
  Body,
  HttpCode,
  HttpStatus,
  Get,
  UseGuards,
  Req,
  Res,
  Query,
} from '@nestjs/common';
import { AuthService } from './auth.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { AuthGuard } from '@nestjs/passport';
import { ConfigService } from '@nestjs/config';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';

import type { Request, Response } from 'express';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private authService: AuthService,
    private configService: ConfigService,
  ) {}

  @Post('register')
  @ApiOperation({ summary: 'Register a new user' })
  @ApiResponse({ status: 201, description: 'User successfully registered.' })
  @ApiResponse({ status: 409, description: 'User already exists.' })
  async register(@Body() registerDto: RegisterDto) {
    return this.authService.register(registerDto);
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Login with email and password' })
  @ApiResponse({ status: 200, description: 'User successfully logged in.' })
  @ApiResponse({ status: 401, description: 'Invalid credentials.' })
  async login(@Body() loginDto: LoginDto) {
    return this.authService.login(loginDto);
  }

  @Get('google')
  @UseGuards(AuthGuard('google'))
  @ApiOperation({ summary: 'Initiate Google OAuth2 login' })
  async googleAuth() {
    // Initiates the Google OAuth2 login flow
  }

  @Get('google/mobile')
  @ApiOperation({
    summary: 'Initiate Google OAuth2 login for mobile (deep link redirect)',
  })
  async googleAuthMobile(
    @Query('mobile_redirect') mobileRedirect: string,
    @Res() res: Response,
  ) {
    const clientId = this.configService.get<string>('GOOGLE_CLIENT_ID');
    const callbackURL =
      this.configService.get<string>('GOOGLE_CALLBACK_URL') ||
      'http://localhost:3000/auth/google/callback';
    const state = Buffer.from(JSON.stringify({ mobileRedirect })).toString(
      'base64',
    );
    const params = new URLSearchParams({
      client_id: clientId!,
      redirect_uri: callbackURL,
      response_type: 'code',
      scope: 'email profile',
      state,
    });
    return res.redirect(
      `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`,
    );
  }

  @Get('google/callback')
  @UseGuards(AuthGuard('google'))
  @ApiOperation({ summary: 'Google OAuth2 callback' })
  async googleAuthRedirect(
    @Req() req: Request,
    @Res() res: Response,
    @Query('state') state: string,
  ) {
    const { token } = req.user as any;

    // Decode mobile_redirect from state if present (set by /auth/google/mobile)
    let mobileRedirect: string | null = null;
    if (state) {
      try {
        const decoded = JSON.parse(
          Buffer.from(state, 'base64').toString('utf8'),
        );
        mobileRedirect = decoded.mobileRedirect || null;
      } catch {
        // ignore malformed state
      }
    }

    if (mobileRedirect) {
      return res.redirect(`${mobileRedirect}?token=${token}`);
    }

    const frontendUrl =
      this.configService.get<string>('FRONTEND_URL') || 'http://localhost:5173';
    return res.redirect(`${frontendUrl}/auth/callback?token=${token}`);
  }

  @Get('apple')
  @UseGuards(AuthGuard('apple'))
  @ApiOperation({ summary: 'Initiate Apple Sign In' })
  async appleAuth() {
    // Initiates the Apple Sign In flow
  }

  @Post('apple/callback')
  @UseGuards(AuthGuard('apple'))
  @ApiOperation({ summary: 'Apple Sign In callback' })
  async appleAuthRedirect(
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const { token } = req.user as any;
    const frontendUrl =
      this.configService.get<string>('FRONTEND_URL') || 'http://localhost:5173';
    return res.redirect(`${frontendUrl}/auth/callback?token=${token}`);
  }
}
