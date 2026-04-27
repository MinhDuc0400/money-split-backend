import { PassportStrategy } from '@nestjs/passport';
import { Strategy, Profile } from 'passport-google-oauth20';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuthService } from '../auth.service';
import { GoogleUser } from '../interfaces/google-user.interface';
import type { Request } from 'express';

@Injectable()
export class GoogleStrategy extends PassportStrategy(Strategy, 'google') {
  constructor(
    configService: ConfigService,
    private authService: AuthService,
  ) {
    const isPlaceholder = (v: string | undefined) =>
      !v || v.startsWith('your-') || v === '';

    const clientID = configService.get<string>('GOOGLE_CLIENT_ID');
    const clientSecret = configService.get<string>('GOOGLE_CLIENT_SECRET');
    const callbackURL =
      configService.get<string>('GOOGLE_CALLBACK_URL') ||
      'http://localhost:3000/auth/google/callback';

    super({
      clientID: isPlaceholder(clientID) ? 'DISABLED' : clientID!,
      clientSecret: isPlaceholder(clientSecret) ? 'DISABLED' : clientSecret!,
      callbackURL,
      scope: ['email', 'profile'],
      passReqToCallback: true,
    });
  }

  async validate(
    req: Request,
    accessToken: string,
    _refreshToken: string,
    profile: Profile,
  ): Promise<any> {
    const { name, emails, photos, id } = profile;
    const user: GoogleUser = {
      googleId: id,
      email: emails?.[0]?.value || '',
      firstName: name?.givenName || '',
      lastName: name?.familyName || '',
      picture: photos?.[0]?.value || '',
      accessToken,
    };
    
    const validated = await this.authService.validateGoogleUser(user);
    const mobileRedirect = (req.query['mobile_redirect'] as string) || null;
    return { ...validated, mobileRedirect };
  }
}
